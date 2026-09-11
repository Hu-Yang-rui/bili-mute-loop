/**
 * harness.js — 在 Node 里模拟直播间页面环境，验证 runtime.js 的循环时序。
 *
 * 运行： node test/harness.js
 *
 * 它 mock 了：window / document / location / cookie / fetch（含 code=0 与限频 -509 两种响应），
 * 然后启动 3 轮循环，断言：
 *   - 每轮先禁言后解禁
 *   - 解禁间隔 (t2 - t1) ≤ 500ms
 *   - -509 按指数退避重试后成功
 *   - unbanDelayMs 配置 999 被夹紧到 500
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RUNTIME = path.join(__dirname, "..", "src", "runtime.js");
const code = fs.readFileSync(RUNTIME, "utf8");

/* ------------------------------------------------------------------ *
 * mock 环境
 * ------------------------------------------------------------------ */
const listeners = [];
const posted = [];          // 页面 → 扩展方向的全部消息
const calls = [];           // 接口调用记录
let roundNo = 0;            // 由测试脚本标记：当前处于第几轮
calls.round = () => { roundNo++; };

function makeWindow() {
  const win = {};
  win.__BML_CONFIG__ = {
    uid: "10086",
    roomId: "21452505",
    unbanDelayMs: 999,      // 故意越界，验证夹紧
    cycleIntervalMs: 50,
    msg: "harness",
    mtype: 1,
    duration: 0,
    useJson: false,
    maxRounds: 3,
    retry: 3,
    retryDelayMs: 20,
    autoStart: false
  };
  win.document = {
    cookie: "bili_jct=FAKE_CSRF_TOKEN; SESSDATA=FAKE",
    getElementById: () => null,
    createElement: () => ({ remove() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  win.location = { pathname: "/21452505", href: "https://live.bilibili.com/21452505" };
  win.addEventListener = (t, fn) => { if (t === "message") listeners.push(fn); };
  win.removeEventListener = () => {};
  win.postMessage = (data) => {
    posted.push(data);
    // 把 dir:"ext" 的消息派发给 runtime 自己的监听器（模拟页面 ↔ 主世界回路）
    if (data && data.dir === "ext") {
      for (const fn of listeners) fn({ source: win, data });
    }
  };
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  return win;
}

const win = makeWindow();

let attempt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url, init) => {
  const isBan = url.includes("room_silence");
  const rec = { url, method: init && init.method, body: init && init.body, t: Date.now(), isBan, round: roundNo };
  calls.push(rec);

  let json = { code: 0, message: "0", data: {} };
  if (isBan && rec.body) {
    const params = new URLSearchParams(rec.body);
    rec.duration = Number(params.get("duration"));
    rec.banned_uid = params.get("banned_uid");
    rec.csrf = params.get("csrf");
    rec.room_id = params.get("room_id");
    // 前两次禁言请求返回限频，验证指数退避
    if (attempt++ < 2) json = { code: -509, message: "请求过于频繁，请稍后再试" };
  }
  await sleep(15); // 模拟网络往返
  return { status: 200, text: async () => JSON.stringify(json) };
};

const ctx = { window: win, document: win.document, location: win.location, fetch: globalThis.fetch,
  setTimeout, clearTimeout, console, URLSearchParams, Date, Math, JSON, Number, Object, String, Error, RegExp, Promise };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: "runtime.js" });

/* ------------------------------------------------------------------ *
 * 断言工具
 * ------------------------------------------------------------------ */
let failures = 0;
function check(name, cond, detail) {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${name}${detail ? "  → " + detail : ""}`);
}

/* ------------------------------------------------------------------ *
 * 跑：3 轮循环
 * ------------------------------------------------------------------ */
(async function main() {
  const t0 = Date.now();
  const api = win.__BML_LOOP__;
  check("runtime 已注册到 window.__BML_LOOP__", !!api && typeof api.start === "function");

  const startRes = api.start(win.__BML_CONFIG__);
  check("start() 立即返回", startRes && startRes.ok === true);
  check("unbanDelayMs 配置 999 被夹紧到 500 上限内（预扣 45ms 抖动余量后为 455）",
    startRes.state.unbanDelayMs === 455, "实际 " + startRes.state.unbanDelayMs);

  // 等循环自然结束（maxRounds=3）
  await new Promise((resolve) => {
    const iv = setInterval(() => { if (!win.__BML_LOOP__.getState().running) { clearInterval(iv); resolve(); } }, 25);
    setTimeout(() => { clearInterval(iv); resolve(); }, 8000);
  });
  const st = api.getState();
  const wall = Date.now() - t0;

  check("已完成配置的 3 轮", st.rounds === 3, "rounds=" + st.rounds);
  check("3 轮全部成功（含 -509 退避重试）", st.okRounds === 3 && st.failRounds === 0,
    `ok=${st.okRounds} fail=${st.failRounds} last=${JSON.stringify(st.lastError)}`);
  check("循环已自动停止", st.running === false);

  const silence = calls.filter((c) => c.isBan);
  const rounds = posted.filter((m) => m.type === "round").map((m) => m.payload);
  check("接口调用次数 = 3 轮 × (2 禁言重试 + 3 次禁言/解禁)", silence.length >= 6, "calls=" + silence.length);
  check("每轮上报一次 round", rounds.length === 3, "rounds=" + rounds.length);

  const gaps = rounds.map((r) => r.unbanGapMs);
  check("每轮 禁言→解禁 间隔 ≤ 500ms", gaps.every((g) => g <= 500), gaps.join(", ") + " ms");
  check("间隔确实生效（未早于 400ms 发出）", gaps.every((g) => g >= 400), gaps.join(", ") + " ms");

  // 校验请求体
  const banReq = silence.find((c) => c.duration !== 0);   // 第一次带 duration 的禁言请求
  const anyBan = silence[0];
  check("请求体带 csrf（取自 cookie bili_jct）", anyBan.csrf === "FAKE_CSRF_TOKEN", "csrf=" + anyBan.csrf);
  check("请求体 banned_uid = 目标 UID", anyBan.banned_uid === "10086", "banned_uid=" + anyBan.banned_uid);
  check("请求体 room_id 正确", anyBan.room_id === "21452505", "room_id=" + anyBan.room_id);

  // 配对校验：mock 侧按调用顺序还原「同一轮的禁言（可含 -509 重试）→ 解禁」。
  // 用 body 里的 msg 字段区分禁言/解禁（解禁时 msg 置空），不依赖 duration。
  const roundsByCall = [];
  for (const c of silence) {
    const params = new URLSearchParams(c.body || "");
    const isBanCall = params.get("msg") !== "";
    const last = roundsByCall[roundsByCall.length - 1];
    if (last && last.stage === "ban" && isBanCall) last.items.push(c);     // 同一轮的禁言重试
    else if (last && last.stage === "unban" && !isBanCall) last.items.push(c);
    else roundsByCall.push({ stage: isBanCall ? "ban" : "unban", items: [c] });
  }
  const pairGaps = [];
  let orderOk = roundsByCall.length === 6;
  for (let i = 0; i + 1 < roundsByCall.length; i += 2) {
    if (roundsByCall[i].stage !== "ban" || roundsByCall[i + 1].stage !== "unban") { orderOk = false; continue; }
    const banDone = roundsByCall[i].items[roundsByCall[i].items.length - 1]; // 禁言成功那次
    const unbanSent = roundsByCall[i + 1].items[0];
    pairGaps.push(unbanSent.t - banDone.t);
  }
  check("每轮顺序均为 禁言 → 解禁（无残留禁言态）", orderOk,
    "sequence=" + roundsByCall.map((g) => g.stage).join("→"));
  check("每对 禁言→解禁 间隔 ≤ 500ms", pairGaps.length === 3 && pairGaps.every((g) => g <= 500),
    pairGaps.join(", ") + " ms");

  // 解禁请求体：msg 必须为空、duration 必须为 0
  const unbanReqs = roundsByCall.filter((g) => g.stage === "unban").map((g) => g.items[0]);
  const unbanOk = unbanReqs.every((c) => {
    const p = new URLSearchParams(c.body);
    return p.get("msg") === "" && p.get("duration") === "0";
  });
  check("解禁请求 msg 为空且 duration=0（不会被误判为再次禁言）", unbanOk, "解禁请求数 " + unbanReqs.length);

  const userMsgs = posted.filter((m) => m.type === "log" || m.type === "status" || m.type === "stopped");
  check("有日志/状态上报给扩展侧", userMsgs.length > 5, "msgs=" + userMsgs.length);
  check("上报了 stopped 事件", posted.some((m) => m.type === "stopped"));
  check("上报了 ready 事件（注入完成）", posted.some((m) => m.type === "ready"));

  console.log("\n--- 时序摘要 ---");
  rounds.forEach((r) => console.log(
    `  第 ${r.index} 轮  禁言请求 ${r.banMs}ms  解禁间隔 ${r.unbanGapMs}ms  解禁 ${r.unbanMs}ms  单轮 ${r.totalMs}ms`));
  console.log(`  墙钟总耗时 ${wall}ms，接口调用 ${calls.length} 次（含 ${calls.length - 6} 次限频重试）`);

  console.log("\n" + (failures === 0 ? "全部通过 ✅" : failures + " 项失败 ❌"));
  process.exit(failures === 0 ? 0 : 1);
})();

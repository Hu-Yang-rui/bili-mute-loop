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
let silenceCount = 0;       // 累计 room_silence 调用次数，用于推算轮次
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url, init) => {
  const isBan = url.includes("room_silence");
  // 实际业务里每轮固定两次 room_silence 调用（禁言 + 解禁），
  // 因此用调用序号推算轮次号（从 1 开始），供断言区分轮次。
  const round = isBan ? Math.floor(silenceCount / 2) + 1 : 0;
  const rec = { url, method: init && init.method, body: init && init.body,
    t: Date.now(), tEnd: null, isBan, round };
  calls.push(rec);
  if (isBan) silenceCount++;

  let json = { code: 0, message: "0", data: {} };
  if (url.includes("/room/v1/Room/get_info")) {
    // 循环开始前的前置检查会读一次房间信息，这里报「直播中」
    json = { code: 0, message: "0", data: { room_id: 21452505, live_status: 1 } };
  } else if (isBan && rec.body) {
    const params = new URLSearchParams(rec.body);
    rec.duration = Number(params.get("duration"));
    rec.banned_uid = params.get("banned_uid");
    rec.csrf = params.get("csrf");
    rec.room_id = params.get("room_id");
    rec.msg = params.get("msg");
    // 前两次禁言请求返回限频，验证指数退避
    if (attempt++ < 2) json = { code: -509, message: "请求过于频繁，请稍后再试" };
  }
  await sleep(15); // 模拟网络往返
  rec.tEnd = Date.now();   // 响应到达时刻（与 runtime 内部的 t1 对齐）
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

  /* ---------------- 按调用顺序还原每一轮的「禁言 → 解禁」 ----------------
   * 注意：msg 现在恒为空串（禁言理由已从面板移除），不能再靠 body 区分两种动作，
   * 只能靠调用顺序 —— 这与 runtime 的实际行为一致：每轮先禁言（可能重试），再解禁。
   */
  // 判据：与「上一次禁言调用」间隔 < 200ms 的，是同一轮的限频重试；
  // 间隔明显更大的那次，就是该轮的解禁。禁言/解禁对之间至少间隔 unbanDelayMs（这里 455ms）。
  const RETRY_WINDOW_MS = 200;
  const roundsByCall = [];
  let lastBanAt = null;
  for (const c of silence) {
    const isRetry = lastBanAt !== null && (c.t - lastBanAt) < RETRY_WINDOW_MS;
    if (isRetry) {
      roundsByCall[roundsByCall.length - 1].items.push(c);
      lastBanAt = c.t;
    } else if (roundsByCall.length && roundsByCall[roundsByCall.length - 1].stage === "ban" &&
               !roundsByCall[roundsByCall.length - 1].paired) {
      roundsByCall[roundsByCall.length - 1].paired = true;   // 该禁言组的解禁
      roundsByCall.push({ stage: "unban", items: [c] });
      lastBanAt = null;
    } else {
      roundsByCall.push({ stage: "ban", items: [c] });
      lastBanAt = c.t;
    }
  }

  const pairGaps = [];
  const sequence = [];
  for (let i = 0; i + 1 < roundsByCall.length; i += 2) {
    const banGroup = roundsByCall[i];
    const unbanGroup = roundsByCall[i + 1];
    if (banGroup.stage !== "ban" || unbanGroup.stage !== "unban") { sequence.push("错序"); continue; }
    sequence.push("ban" + (banGroup.items.length > 1 ? "(+重试×" + (banGroup.items.length - 1) + ")" : "") +
      "→unban");
    // runtime 的 unbanGapMs = 解禁发出时刻 − 禁言成功响应时刻
    const banDoneAt = banGroup.items[banGroup.items.length - 1].tEnd;
    pairGaps.push(unbanGroup.items[0].t - banDoneAt);
  }
  check("每轮顺序均为 禁言 → 解禁（无残留禁言态）",
    pairGaps.length === 3 && sequence.every((s) => s.includes("→unban")),
    "sequence=" + sequence.join(" | "));
  check("每对 禁言→解禁 间隔 ≤ 500ms（按请求实测时刻计算）",
    pairGaps.length === 3 && pairGaps.every((g) => g <= 500), pairGaps.join(", ") + " ms");

  const unbanReqs = roundsByCall.filter((g) => g.stage === "unban").map((g) => g.items[0]);
  const banReqs = roundsByCall.filter((g) => g.stage === "ban").map((g) => g.items[g.items.length - 1]);

  // 解禁请求体：msg 必须为空、duration 必须为 0（否则会被后端当成再次禁言）
  const unbanOk = unbanReqs.every((c) => {
    const p = new URLSearchParams(c.body);
    return p.get("msg") === "" && p.get("duration") === "0";
  });
  check("解禁请求 msg 为空且 duration=0（不会被误判为再次禁言）", unbanOk, "解禁请求数 " + unbanReqs.length);

  // 禁言请求体：房管禁言不需要理由，msg 同样固定为空串
  check("禁言请求不再携带理由（msg 恒为空串）",
    banReqs.every((c) => new URLSearchParams(c.body).get("msg") === ""),
    "禁言请求数 " + banReqs.length);

  // 请求体不应再包含已下线的 msg 之外的游离字段
  check("请求体只含约定字段（room_id/banned_uid/msg/mtype/duration/csrf）",
    banReqs.every((c) => {
      const keys = [...new URLSearchParams(c.body).keys()].sort().join(",");
      return keys === "banned_uid,csrf,duration,msg,mtype,room_id";
    }),
    banReqs.length ? [...new URLSearchParams(banReqs[0].body).keys()].join(",") : "(无禁言请求)");

  // 前置检查：循环开始前会探测开播状态
  check("启动前探测了房间开播状态（get_info）",
    calls.some((c) => c.url.includes("/room/v1/Room/get_info")),
    "get_info 调用 " + calls.filter((c) => c.url.includes("get_info")).length + " 次");

  const userMsgs = posted.filter((m) => m.type === "log" || m.type === "status" || m.type === "stopped");
  check("有日志/状态上报给扩展侧", userMsgs.length > 5, "msgs=" + userMsgs.length);
  check("上报了 stopped 事件", posted.some((m) => m.type === "stopped"));
  check("上报了 ready 事件（注入完成）", posted.some((m) => m.type === "ready"));

  console.log("\n--- 时序摘要 ---");
  rounds.forEach((r) => console.log(
    `  第 ${r.index} 轮  禁言请求 ${r.banMs}ms  解禁间隔 ${r.unbanGapMs}ms  解禁 ${r.unbanMs}ms  单轮 ${r.totalMs}ms`));
  const infoCount = calls.filter((c) => !c.isBan).length;
  console.log(`  墙钟总耗时 ${wall}ms，接口调用 ${calls.length} 次` +
    `（room_silence ${silence.length} 次，含 ${silence.length - 6} 次限频重试；房间信息 ${infoCount} 次）`);

  console.log("\n" + (failures === 0 ? "全部通过 ✅" : failures + " 项失败 ❌"));
  process.exit(failures === 0 ? 0 : 1);
})();

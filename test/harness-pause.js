/**
 * harness-pause.js — 验证「暂停 / 继续」语义。
 *
 * 运行： node test/harness-pause.js
 *
 * 断言：
 *   1. pause 后不再开始新一轮，但 running 仍为 true（属于暂停而非停止）；
 *   2. 暂停期间计数被冻结；
 *   3. resume 后循环继续，计数继续累加；
 *   4. stop 能在暂停状态下正常退出（不会卡在挂起循环里）；
 *   5. 消息协议 pause / resume 能通过 window.postMessage 触发并回 ack。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "src", "runtime.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? "  → " + detail : ""}`);
}

/* ------------------------------------------------------------------ *
 * 独立沙箱（与 harness.js 环境隔离，互不干扰）
 * ------------------------------------------------------------------ */
function makeEnv(config) {
  const listeners = [];
  const posted = [];
  const win = {
    __BML_CONFIG__: config,
    document: { cookie: "bili_jct=FAKE_CSRF_TOKEN", getElementById: () => null, head: { appendChild() {} } },
    location: { pathname: "/21452505", href: "https://live.bilibili.com/21452505" },
    addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (data) => {
      posted.push(data);
      if (data && data.dir === "ext") for (const fn of listeners) fn({ source: win, data });
    }
  };
  const fetchImpl = async (url, init) => {
    await sleep(10);
    return { status: 200, text: async () => JSON.stringify({ code: 0, message: "0", data: {} }) };
  };
  const ctx = {
    window: win, document: win.document, location: win.location, fetch: fetchImpl,
    setTimeout, clearTimeout, console, URLSearchParams, Date, Math, JSON, Number, Object, String,
    Error, RegExp, Promise
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { filename: "runtime.js" });
  return { win, posted, api: win.__BML_LOOP__ };
}

const RUNTIME_CFG = {
  uid: "10086", roomId: "21452505", unbanDelayMs: 120, cycleIntervalMs: 80,
  msg: "harness", mtype: 1, duration: 0, useJson: false,
  maxRounds: 50, retry: 1, retryDelayMs: 20, autoStart: false
};

(async function main() {
  const env = makeEnv(RUNTIME_CFG);
  const api = env.api;
  check("runtime 注册成功", !!api && typeof api.pause === "function" && typeof api.resume === "function");

  // ---- 1. 未运行时 pause 应被拒绝 ----
  const early = api.pause();
  check("未运行时 pause 返回 not-running", early.ok === false && early.reason === "not-running",
    JSON.stringify(early.reason));

  // ---- 2. 启动并跑几轮 ----
  api.start(RUNTIME_CFG);
  await sleep(700);
  const beforePause = api.getState();
  check("暂停前已开始跑轮次", beforePause.rounds >= 2,
    "rounds=" + beforePause.rounds + " running=" + beforePause.running);

  // ---- 3. 暂停 ----
  const p = api.pause();
  check("pause() 生效且 running 保持 true",
    p.ok === true && p.state.paused === true && p.state.running === true,
    "paused=" + p.state.paused + " running=" + p.state.running);

  // 暂停是在「一轮边界」生效：正在跑的那一轮会跑完（禁言 → 解禁）才挂起，
  // 因此最多允许在途的 1 轮完成，之后计数必须完全冻结。
  await sleep(400);
  const roundsAtPause = api.getState().rounds;
  check("暂停最多让在途的 1 轮跑完（不留禁言态）",
    roundsAtPause - p.state.rounds <= 1,
    `pause 时 rounds=${p.state.rounds} → 400ms 后 rounds=${roundsAtPause}`);

  await sleep(900);   // 900ms 足够原本再跑 4~5 轮
  const afterPause = api.getState();
  check("挂起后 900ms 内没有开始新一轮", afterPause.rounds === roundsAtPause,
    `${roundsAtPause} → ${afterPause.rounds}`);
  check("暂停期间状态标记正确", afterPause.paused === true && afterPause.running === true &&
    afterPause.pausedAt > 0, "pausedAt=" + afterPause.pausedAt);
  check("暂停期间发出 status 上报（popup 可感知）",
    env.posted.some((m) => m.type === "status" && m.payload && m.payload.paused === true));

  // ---- 4. 继续 ----
  const r = api.resume();
  check("resume() 生效", r.ok === true && r.state.paused === false, "paused=" + r.state.paused);
  await sleep(700);
  const resumed = api.getState();
  check("继续后计数继续累加", resumed.rounds > roundsAtPause,
    `resume 时 rounds=${roundsAtPause} → 700ms 后 rounds=${resumed.rounds}`);

  // ---- 5. 消息协议：pause / resume ----
  const ackOf = (type) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 800);
    const iv = setInterval(() => {
      const hit = env.posted.find((m) => m.type === "ack" && m.payload && m.payload.req === type);
      if (hit) { clearTimeout(t); clearInterval(iv); resolve(hit.payload); }
    }, 20);
  });
  const pAckP = ackOf("pause");
  env.win.postMessage({ channel: "BML_LOOP", dir: "ext", type: "pause" });
  const pauseAck = await pAckP;
  check("postMessage 协议 pause 返回 ack", !!pauseAck && pauseAck.ok === true,
    JSON.stringify(pauseAck && pauseAck.state ? { ok: pauseAck.ok, paused: pauseAck.state.paused } : pauseAck));

  const pAckR = ackOf("resume");
  env.win.postMessage({ channel: "BML_LOOP", dir: "ext", type: "resume" });
  const resumeAck = await pAckR;
  check("postMessage 协议 resume 返回 ack", !!resumeAck && resumeAck.ok === true,
    JSON.stringify(resumeAck && resumeAck.state ? { ok: resumeAck.ok, paused: resumeAck.state.paused } : resumeAck));

  // ---- 6. 暂停状态下 stop 必须能退出（不能卡死） ----
  api.pause();
  // 与前面同理：在途的那一轮会先跑完再挂起，等它结算完再取基准值，
  // 否则会把「在途轮次完成」误判成「停止后又多跑了一轮」。
  await sleep(400);
  const roundsAtStop = api.getState().rounds;
  const t0 = Date.now();
  const stopped = await Promise.race([
    api.stop(),
    sleep(3000).then(() => ({ ok: false, reason: "TIMEOUT" }))
  ]);
  const stopMs = Date.now() - t0;
  check("暂停状态下 stop() 能正常退出（<3s）",
    stopped.ok === true && stopped.state.running === false,
    `耗时 ${stopMs}ms，running=${stopped.state && stopped.state.running}`);
  check("退出后 paused 被复位", stopped.state.paused === false, "paused=" + stopped.state.paused);
  check("停止不会额外跑轮次", stopped.state.rounds === roundsAtStop,
    `${roundsAtStop} → ${stopped.state.rounds}`);
  check("上报了 stopped 事件", env.posted.some((m) => m.type === "stopped"));

  // ---- 7. 停止后可重新 start ----
  const re = api.start(RUNTIME_CFG);
  await sleep(400);
  const after = api.getState();
  check("停止后可以重新开始（计数归零重跑）", re.ok === true && after.running === true && after.rounds >= 1,
    "rounds=" + after.rounds);
  await api.stop();

  console.log("\n" + (failures === 0 ? "暂停/继续 全部通过 ✅" : failures + " 项失败 ❌"));
  process.exit(failures === 0 ? 0 : 1);
})();

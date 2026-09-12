/**
 * harness-live.js — 验证「未开播」相关的行为。
 *
 * 运行： node test/harness-live.js
 *
 * 覆盖：
 *   1. 未开播 + 未勾选等待：启动即被拦下，报 -404，且**不发出任何禁言请求**；
 *   2. 未开播 + 勾选等待：进入 waiting-live 挂起，开播后自动开始循环；
 *   3. 直播中下播：本轮失败（-404），下播期间不发禁言请求，复播后自动接续；
 *   4. probe() 在未开播时跳过黑名单查询并给出说明。
 *
 * 为了让等待期的轮询不至于拖慢测试，这里把 runtime 源码里的
 * WAIT_LIVE_POLL_MS（15s）替换成 250ms 后再注入沙箱；发布用的源码不变。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RAW = fs.readFileSync(path.join(__dirname, "..", "src", "runtime.js"), "utf8");
const CODE = RAW.replace(/const WAIT_LIVE_POLL_MS = \d+;/, "const WAIT_LIVE_POLL_MS = 250;");
if (CODE === RAW) {
  console.error("未能替换 WAIT_LIVE_POLL_MS，测试需要更新");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
  if (!cond) failures++;
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${detail ? "  → " + detail : ""}`);
}

/* ------------------------------------------------------------------ *
 * 沙箱：可控的 live_status
 * ------------------------------------------------------------------ */
function makeEnv(config) {
  const listeners = [];
  const posted = [];
  const calls = [];
  const ctl = {
    liveStatus: 1,
    liveStatusSequence: null,
    liveStatusAfter: undefined,     // 序列用尽后固定返回的状态
    seqIdx: 0,
    sendInfo: true,
    /** 未开播时 room_silence 应被后端拒绝 */
    acceptSilence() { return ctl.liveStatus !== 0; }
  };

  const win = {
    __BML_CONFIG__: config,
    document: { cookie: "bili_jct=FAKE_CSRF_TOKEN", getElementById: () => null, head: { appendChild() {} } },
    location: { pathname: "/21452505", href: "https://live.bilibili.com/21452505" },
    addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
    removeEventListener: () => {},
    postMessage: (d) => {
      posted.push(d);
      if (d && d.dir === "ext") for (const fn of listeners) fn({ source: win, data: d });
    }
  };

  const fetchImpl = async (url, init) => {
    const isInfo = url.includes("/room/v1/Room/get_info");
    const isSilence = url.includes("room_silence");
    calls.push({ url, isInfo, isSilence, body: init && init.body, t: Date.now() });

    let json = { code: 0, message: "0", data: {} };
    if (isInfo) {
      // 按序返回预设的开播状态（用于模拟「开播 / 下播 / 复播」）；
      // liveStatusSequence 为空数组时视为不再设置 live_status。
      let ls = ctl.liveStatus;
      if (ctl.liveStatusSequence) {
        if (ctl.seqIdx < ctl.liveStatusSequence.length) ls = ctl.liveStatusSequence[ctl.seqIdx++];
        else if (ctl.liveStatusAfter === undefined) {
          ls = ctl.liveStatusSequence[ctl.liveStatusSequence.length - 1];
        }
        if (ctl.liveStatusAfter !== undefined) ls = ctl.liveStatusAfter;
      }
      json = (ctl.sendInfo && ls !== undefined)
        ? { code: 0, message: "0", data: { room_id: 21452505, live_status: ls } }
        : { code: 0, message: "0", data: { room_id: 21452505 } };  // 不带 live_status → 状态未知
    } else if (isSilence && !ctl.acceptSilence()) {
      // 未开播时平台对 room_silence 的直接拒绝（这正是真实平台的行为）
      json = { code: 1, message: "该直播间未开播", data: {} };
    }
    await sleep(6);
    return { status: 200, text: async () => JSON.stringify(json) };
  };

  const ctx = {
    window: win, document: win.document, location: win.location, fetch: fetchImpl,
    setTimeout, clearTimeout, console, URLSearchParams, Date, Math, JSON, Number, Object, String,
    Error, RegExp, Promise
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: "runtime.js" });
  return { win, posted, calls, ctl, api: win.__BML_LOOP__ };
}

const BASE = {
  uid: "10086", roomId: "21452505", unbanDelayMs: 60, cycleIntervalMs: 60,
  mtype: 1, duration: 0, useJson: false, maxRounds: 0, retry: 0, retryDelayMs: 10, autoStart: false
};

const silenceCalls = (env) => env.calls.filter((c) => c.isSilence);
const infoCalls = (env) => env.calls.filter((c) => c.isInfo);
const lastStopped = (env) => {
  const s = env.posted.filter((m) => m.type === "stopped");
  return s.length ? s[s.length - 1].payload : null;
};

(async function main() {
  /* ---------------- 1. 未开播 + 未勾选等待 ---------------- */
  console.log("【场景 1】未开播且未勾选等待\n");
  {
    const env = makeEnv(BASE);
    env.ctl.liveStatus = 0;
    const res = env.api.start(BASE);
    check("start() 立即返回 running=true（前置检查在循环内异步执行）", res.ok === true);

    // 前置检查很快返回 -404 并结束
    await sleep(400);
    const st = env.api.getState();
    check("前置检查失败后自动停止", st.running === false, "running=" + st.running);
    check("错误阶段标记为 preflight 且 code=-404",
      st.lastError && st.lastError.stage === "preflight" && st.lastError.code === -404,
      JSON.stringify(st.lastError));
    check("失败原因包含「未开播」", st.lastError && /未开播/.test(st.lastError.message),
      st.lastError && st.lastError.message);
    check("未开播时没有发出任何禁言/解禁请求", silenceCalls(env).length === 0,
      "room_silence 调用 " + silenceCalls(env).length + " 次");
    check("未开播时不请求黑名单接口",
      !env.calls.some((c) => c.url.includes("QueryBlackListUser")));
    check("发出了 stopped 事件", lastStopped(env) !== null);
  }

  /* ---------------- 2. 未开播 + 勾选等待开播 ---------------- */
  console.log("\n【场景 2】未开播且勾选等待开播\n");
  {
    const cfg = Object.assign({}, BASE, { waitForLive: true, maxRounds: 2 });
    const env = makeEnv(cfg);
    // 前 2 次探测报未开播，之后报直播中
    env.ctl.liveStatusSequence = [0, 0, 1];

    env.api.start(cfg);
    await sleep(350);   // 此时应处于等待中（第 1~2 次探测）

    const during = env.api.getState();
    check("等待期间处于 waiting-live 状态",
      during.phase === "waiting-live" && during.waitingLive === true && during.running === true,
      "phase=" + during.phase + " running=" + during.running);
    check("等待期间没有发出禁言请求", silenceCalls(env).length === 0,
      "room_silence 调用 " + silenceCalls(env).length + " 次");
    check("等待期间持续探测开播状态（>=2 次）", infoCalls(env).length >= 2,
      "get_info 调用 " + infoCalls(env).length + " 次");
    check("上报了 running 的 status（popup 可显示等待中）",
      env.posted.some((m) => m.type === "status" && m.payload && m.payload.waitingLive === true));

    // 等它开播并跑完 2 轮
    for (let i = 0; i < 60 && env.api.getState().running; i++) await sleep(100);
    const after = env.api.getState();
    check("开播后自动进入循环并跑完配置的轮数",
      after.running === false && after.rounds >= 2,
      "rounds=" + after.rounds + " ok=" + after.okRounds);
    check("开播后确实发出了禁言请求", silenceCalls(env).length >= 2,
      "room_silence 调用 " + silenceCalls(env).length + " 次");
    check("最终没有残留失败轮次", after.failRounds === 0, "fail=" + after.failRounds);
  }

  /* ---------------- 3. 直播中下播 → 复播接续 ---------------- */
  console.log("\n【场景 3】直播中下播，复播后自动接续\n");
  {
    const cfg = Object.assign({}, BASE, { cycleIntervalMs: 80, unbanDelayMs: 60 });
    const env = makeEnv(cfg);
    // 时间线：前置检查时直播中 → 100ms 后下播 → 700ms 后复播。
    // 下播期间：本地 10s 短缓存仍标着「直播中」，所以第一次是靠接口拒绝（code=1）
    // 发现的；runtime 随后清空缓存并退避，下一轮重新实时探测拿到「未开播」（-404）。
    env.ctl.liveStatus = 1;
    setTimeout(() => { env.ctl.liveStatus = 0; }, 100);
    setTimeout(() => { env.ctl.liveStatus = 1; }, 700);

    env.api.start(cfg);
    // 下播期间每轮失败后按 min(WAIT_LIVE_POLL_MS, 5000) 退避（测试里把轮询间隔改成 250ms），
    // 这里留足时间让「失败 → 复播 → 成功」整条链路走完。
    await sleep(1800);

    const st = env.api.getState();
    const fails = st.failRounds;
    if (process.env.BML_DEBUG) {
      console.log("  [dbg] get_info=" + infoCalls(env).length + " room_silence=" + silenceCalls(env).length);
      console.log("  [dbg] codes=" + JSON.stringify([
        ...new Set(env.posted.filter((m) => m.type === "log" && m.payload && m.payload.level === "err")
          .map((m) => m.payload.code))
      ]));
    }
    const errLogs = env.posted.filter((m) => m.type === "log" && m.payload && m.payload.level === "err");
    const codes = [...new Set(errLogs.map((m) => m.payload.code))];
    check("下播期间产生了失败轮次，且日志中出现 -404（本地实时探测判定）",
      fails >= 1 && codes.includes(-404),
      "failRounds=" + fails + " 日志错误码=" + JSON.stringify(codes));
    check("复播后重新出现成功轮次（自动接续）", st.okRounds >= 1,
      "ok=" + st.okRounds + " fail=" + st.failRounds);

    await env.api.stop();
    const s = env.api.getState();
    check("可正常停止", s.running === false, "running=" + s.running);
  }

  /* ---------------- 4. probe() 在未开播时的行为 ---------------- */
  console.log("\n【场景 4】probe() 在未开播时跳过黑名单查询\n");
  {
    const env = makeEnv(BASE);
    env.ctl.liveStatus = 0;
    const r = await env.api.probe(Object.assign({}, BASE, { uid: "10086" }));
    check("probe 返回 ok 且标记未开播", r.ok === true && r.liveStatus === 0,
      "liveStatus=" + r.liveStatus + " text=" + r.liveStatusText);
    check("probe 给出未开播说明", typeof r.note === "string" && /未开播/.test(r.note), r.note);
    check("probe 不请求黑名单接口",
      !env.calls.some((c) => c.url.includes("QueryBlackListUser")));

    const env2 = makeEnv(BASE);
    env2.ctl.liveStatus = 1;
    const r2 = await env2.api.probe(Object.assign({}, BASE, { uid: "10086" }));
    check("开播时 probe 会查询黑名单并返回结论",
      r2.ok === true && r2.liveStatus === 1 && typeof r2.banned === "boolean",
      "liveStatus=" + r2.liveStatus + " banned=" + r2.banned);
  }

  /* ---------------- 5. 状态未知时不拦截 ---------------- */
  console.log("\n【场景 5】拿不到 live_status 时不误拦\n");
  {
    const cfg = Object.assign({}, BASE, { maxRounds: 1 });
    const env = makeEnv(cfg);
    env.ctl.sendInfo = false;   // data 里没有 live_status
    env.api.start(cfg);
    for (let i = 0; i < 40 && env.api.getState().running; i++) await sleep(50);
    const st = env.api.getState();
    check("状态未知时依然正常执行（不因 unknown 被拦截）",
      st.okRounds === 1 && st.failRounds === 0,
      "ok=" + st.okRounds + " fail=" + st.failRounds + " liveStatus=" + st.liveStatus);
  }

  console.log("\n" + (failures === 0 ? "未开播 / 等待开播 全部通过 ✅" : failures + " 项失败 ❌"));
  process.exit(failures === 0 ? 0 : 1);
})();

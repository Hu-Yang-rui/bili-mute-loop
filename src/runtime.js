/**
 * runtime.js — 页面主世界（MAIN world）执行体。
 *
 * 为什么必须在 MAIN world 跑：
 *   房间禁言/解禁接口依赖直播间页面自身的登录态（SESSDATA / bili_jct cookie）
 *   以及接口校验，扩展的 ISOLATED world 里 fetch 的 cookie 行为与页面上下文
 *   存在差异，直接在页面上下文发起请求最稳定。
 *
 * 通信协议（全部走 window.postMessage，channel = "BML_LOOP"）：
 *   页面 → popup/background : { channel, dir:"page", type:"ready"|"status"|"log"|"round"|"stopped", payload }
 *   popup/background → 页面 : { channel, dir:"ext",  type:"start"|"stop"|"ping"|"update", payload }
 */

(function () {
  "use strict";

  const CHANNEL = "BML_LOOP";
  const NS = "__BML_LOOP__";

  // 防止重复注入（popup 与 bridge 可能同时注入）
  if (window.__BML_LOOP_INSTALLED__) {
    post("ready", { already: true, state: window[NS] ? window[NS].getState() : null });
    return;
  }
  window.__BML_LOOP_INSTALLED__ = true;

  /* ------------------------------------------------------------------ *
   * 默认配置
   * ------------------------------------------------------------------ */
  const DEFAULTS = {
    uid: "",             // 目标用户 UID（字符串，避免大数精度丢失）
    roomId: "",          // 房间号；留空 = 使用页面内置的 room_id
    unbanDelayMs: 300,   // 禁言成功 → 解禁请求 的等待毫秒数（硬上限 500，实际发出会再提前 UNBAN_SAFETY_MS）
    cycleIntervalMs: 800,// 一轮「禁言+解禁」完成 → 下一轮开始 的间隔
    // 禁言理由：见下方 setSilence() 注释。默认值刻意保持中性、可辨识，
    // 便于事后在平台操作记录里按关键词定位；它不会被本扩展发到聊天框。
    msg: "接口联调测试",
    mtype: 1,            // 禁言类型：1=直播间禁言
    duration: 0,         // 禁言时长（秒），0 = 默认/永久
    useJson: false,      // true = 以 JSON body 发送（部分接口入口）
    apiBase: "https://api.live.bilibili.com",
    maxRounds: 0,        // 0 = 无限循环
    retry: 3,            // 单次请求失败重试次数
    retryDelayMs: 250,   // 重试基础间隔（指数退避）
    autoStart: true      // 进入直播间后自动按已保存配置启动
  };

  const CFG = Object.assign({}, DEFAULTS, window.__BML_CONFIG__ || {});
  window.__BML_CONFIG__ = CFG;

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms | 0)));
  const now = () => Date.now();

  /**
   * 睡到绝对时间点。setTimeout 本身有 1–16ms 的调度抖动，
   * 若直接用 sleep(500)，实测会出现 503–516ms 的漂移、越过 500ms 约束；
   * 这里按绝对 deadline 自校正（提前醒就补睡）。
   */
  async function sleepUntil(deadline) {
    for (let i = 0; i < 8; i++) {
      const left = deadline - now();
      if (left <= 0) return;
      await sleep(left);
    }
  }

  /**
   * 硬约束常量：需求要求「禁言完成 → 解除禁言」≤ 500ms。
   * 该值既是配置上限，也用于计算安全余量。
   */
  const HARD_UNBAN_LIMIT_MS = 500;

  /**
   * 抖动安全余量。实测（Chrome / Node 事件循环）：定时器 1–16ms 抖动，
   * 加上一次事件循环 tick 与 fetch 派发开销约 10–30ms，合计可达 40ms 以上。
   * 因此把用户配置值整体提前 UNBAN_SAFETY_MS，保证端到端实测间隔仍 < 500ms。
   */
  const UNBAN_SAFETY_MS = 45;

  /** 把用户配置夹紧到 [0, HARD_UNBAN_LIMIT_MS]，超出部分留作抖动余量 */
  function clampUnbanDelay(v) {
    const n = Number(v);
    const ms = Number.isFinite(n) ? Math.max(0, Math.min(HARD_UNBAN_LIMIT_MS, n)) : DEFAULTS.unbanDelayMs;
    return Math.max(0, ms - UNBAN_SAFETY_MS);
  }

  function post(type, payload) {
    window.postMessage({ channel: CHANNEL, dir: "page", type, payload: payload || null }, "*");
  }
  function log(level, text, extra) {
    post("log", Object.assign({ level, text, t: now() }, extra || {}));
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }
  const getCsrf = () => getCookie("bili_jct");

  /**
   * 直播间号解析优先级：
   *   1) 用户填写的房间号
   *   2) 页面内置的真实 room_id（__NEPTUNE_IS_MY_WAIFU__.roomInitRes.data.room_id）
   *   3) window.roomId / window.room_id
   *   4) URL 中的数字（可能是短号，接口需要真实房间号，见 resolveRoomIdAsync 回退）
   */
  function resolveRoomId() {
    if (CFG.roomId) return String(CFG.roomId).trim();
    const w = window;
    const cands = [
      w.__NEPTUNE_IS_MY_WAIFU__ && w.__NEPTUNE_IS_MY_WAIFU__.roomInitRes &&
        w.__NEPTUNE_IS_MY_WAIFU__.roomInitRes.data &&
        w.__NEPTUNE_IS_MY_WAIFU__.roomInitRes.data.room_id,
      w.__NEPTUNE_IS_MY_WAIFU__ && w.__NEPTUNE_IS_MY_WAIFU__.roomInfoRes &&
        w.__NEPTUNE_IS_MY_WAIFU__.roomInfoRes.data &&
        w.__NEPTUNE_IS_MY_WAIFU__.roomInfoRes.data.room_id,
      w.roomId,
      w.room_id
    ];
    for (const c of cands) if (c) return String(c);
    const m = location.pathname.match(/\/(?:blanc\/)?(\d+)/);
    return m ? m[1] : "";
  }

  /** URL 里是短号时，用 get_info 换成真实房间号（接口只认真实号） */
  async function resolveRoomIdAsync() {
    const id = resolveRoomId();
    if (!id || CFG.roomId) return id;
    try {
      const d = await requestWithRetry(
        "/room/v1/Room/get_info?room_id=" + encodeURIComponent(id), { method: "GET" });
      const real = d && d.data && d.data.room_id;
      if (real) return String(real);
    } catch (_) { /* 短号也能直接用的情况很多，失败就沿用原值 */ }
    return id;
  }

  function biliError(code, message) {
    const err = new Error(message || ("bilibili code " + code));
    err.biliCode = code;
    return err;
  }

  /* ------------------------------------------------------------------ *
   * 接口客户端
   * ------------------------------------------------------------------ */
  const API = {
    // 查询某用户在当前房间的禁言状态
    check: (roomId, uid) =>
      "/xlive/web-ucenter/v1/banned/QueryBlackListUser?room_id=" +
      encodeURIComponent(roomId) + "&uid=" + encodeURIComponent(uid),

    // 禁言 / 解禁（同一入口，uid=0 表示解除）
    act: "/xroom/v1/Room/room_silence"
  };

  async function request(path, { method = "GET", form = null, json = null } = {}) {
    const url = CFG.apiBase + path;
    const init = {
      method,
      credentials: "include",
      headers: {}
    };
    if (form) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) body.append(k, String(v));
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = body.toString();
    } else if (json) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { throw biliError(-1, "响应非 JSON：" + text.slice(0, 160)); }
    return { http: res.status, data };
  }

  /** 带重试与指数退避的请求包装 */
  async function requestWithRetry(path, opts) {
    let lastErr;
    for (let i = 0; i <= CFG.retry; i++) {
      try {
        const r = await request(path, opts);
        if (r.data && r.data.code === 0) return r.data;
        const code = r.data ? r.data.code : r.http;
        // -412 风控 / -509 限频：值得退避重试；其余业务错误直接抛出
        if (code === -412 || code === -509 || code === -504) {
          lastErr = biliError(code, r.data && r.data.message);
        } else {
          throw biliError(code, (r.data && (r.data.message || r.data.msg)) || undefined);
        }
      } catch (e) {
        lastErr = e;
      }
      if (i < CFG.retry) await sleep(CFG.retryDelayMs * Math.pow(2, i));
    }
    throw lastErr;
  }

  async function fetchRemoteConfig() {
    // 接口需要登录态与 csrf，这里只做前置校验，避免无意义请求
    const csrf = getCsrf();
    if (!csrf) throw biliError(-101, "未取到 bili_jct（请先在该浏览器登录 B 站）");
    const roomId = await resolveRoomIdAsync();
    if (!roomId) throw biliError(-400, "未取到房间号，请手动填写");
    return { csrf, roomId };
  }

  async function setSilence({ roomId, uid, seconds, csrf, msg, mtype, useJson }) {
    const payload = {
      room_id: roomId,
      banned_uid: Number(uid),
      // 注意：解禁时 msg 必须为空串，不能用 `msg || CFG.msg`，
      // 否则会被默认理由覆盖，导致解禁请求被后端当成一次新的禁言。
      msg: msg === undefined ? CFG.msg : msg,
      mtype: Number(mtype == null ? CFG.mtype : mtype),
      duration: Number(seconds | 0),
      csrf
    };
    return requestWithRetry(API.act, useJson ? { method: "POST", json: payload } : { method: "POST", form: payload });
  }

  const ban = (o) => setSilence(Object.assign({}, o, { seconds: o.seconds > 0 ? o.seconds : 0 }));
  const unban = (o) => setSilence(Object.assign({}, o, { seconds: 0, msg: "" }));

  async function queryBanned(roomId, uid) {
    const d = await requestWithRetry(API.check(roomId, uid), { method: "GET" });
    return d; // { code:0, data:{ uid, ... } } 命中即在线名单中
  }

  /* ------------------------------------------------------------------ *
   * 循环引擎
   * ------------------------------------------------------------------ */
  const state = {
    running: false,
    paused: false,        // 暂停：保留全部计数，仅在「一轮边界」挂起
    rounds: 0,
    okRounds: 0,
    failRounds: 0,
    lastRound: null,
    lastError: null,
    startedAt: 0,
    pausedAt: 0,
    stopping: false,
    injectedAt: now()
  };

  let loopPromise = null;
  let cfgLive = Object.assign({}, CFG);

  function snapshot() {
    return {
      running: state.running,
      paused: state.paused,
      pausedAt: state.pausedAt,
      rounds: state.rounds,
      okRounds: state.okRounds,
      failRounds: state.failRounds,
      lastRound: state.lastRound,
      lastError: state.lastError,
      startedAt: state.startedAt,
      injectedAt: state.injectedAt,
      uid: cfgLive.uid,
      roomId: resolveRoomId(),
      unbanDelayMs: cfgLive.unbanDelayMs,
      cycleIntervalMs: cfgLive.cycleIntervalMs,
      maxRounds: cfgLive.maxRounds
    };
  }
  function emitStatus() { post("status", snapshot()); }

  async function runOneRound(i) {
    const started = now();
    const { csrf, roomId } = await fetchRemoteConfig();
    if (!cfgLive.uid) throw biliError(-400, "未填写目标 UID");

    const useJson = !!cfgLive.useJson;

    // 1) 禁言
    const t0 = now();
    try {
      await ban({
        roomId, uid: cfgLive.uid, seconds: cfgLive.duration, csrf,
        msg: cfgLive.msg, mtype: cfgLive.mtype, useJson
      });
    } catch (e) {
      e.stage = "ban";
      throw e;
    }
    const t1 = now();

    // 2) 等 unbanDelayMs 后解禁（需求：0.5s 内）。
    //    以「禁言响应到达时刻」为基准算绝对 deadline，避免 setTimeout 抖动导致超时。
    const unbanDeadline = t1 + cfgLive.unbanDelayMs;
    await sleepUntil(unbanDeadline);

    // 3) 解禁：可能命中 "禁言后短时间内无法解禁" 这类后端保护，
    //    此时按退避重试，直到成功或超出重试预算。
    const t2 = now();
    try {
      await unban({ roomId, uid: cfgLive.uid, csrf, mtype: cfgLive.mtype, useJson });
    } catch (e) {
      e.stage = "unban";
      throw e;
    }
    const t3 = now();

    const round = {
      index: i,
      banMs: t1 - t0,
      unbanGapMs: t2 - t1,       // 禁言成功 → 解禁发出（需求 < 500ms 即看这个值）
      unbanMs: t3 - t2,
      totalMs: t3 - started,
      at: now()
    };
    state.lastRound = round;
    post("round", round);
    return round;
  }

  /**
   * 暂停等待：仅在「一轮边界」生效。
   * 一轮内部（禁言 → 解禁）绝不会被暂停打断，因此不会留下
   * 「已禁言但没解禁」的中间态 —— 用户被禁言的最长时间就是一轮的
   * unbanDelayMs（≤500ms），暂停只是不再开始新的一轮。
   */
  async function waitWhilePaused() {
    if (!state.paused) return;
    while (state.paused && state.running && !state.stopping) {
      await sleep(100);
    }
  }

  async function loop() {
    state.running = true;
    state.stopping = false;
    state.paused = false;
    state.pausedAt = 0;
    state.startedAt = now();
    state.rounds = 0; state.okRounds = 0; state.failRounds = 0; state.lastError = null;
    emitStatus();
    log("info", "循环开始：room=" + resolveRoomId() + " uid=" + cfgLive.uid +
      " 解禁延迟=" + cfgLive.unbanDelayMs + "ms 周期间隔=" + cfgLive.cycleIntervalMs + "ms");

    let i = 0;
    while (!state.stopping) {
      i++;
      try {
        await runOneRound(i);
        state.rounds = i;
        state.okRounds++;
        state.lastError = null;
        log("ok", "第 " + i + " 轮：禁言→解禁完成", { round: state.lastRound });
      } catch (e) {
        state.rounds = i;
        state.failRounds++;
        state.lastError = { stage: e.stage || "unknown", code: e.biliCode, message: String(e.message || e) };
        log("err", "第 " + i + " 轮失败[" + (e.stage || "?") + "]: " + (e.biliCode != null ? "code=" + e.biliCode + " " : "") + (e.message || e));
        // 风控/登录态问题：退避久一点，避免连续打接口
        if (e.biliCode === -412 || e.biliCode === -509 || e.biliCode === -101) {
          await sleep(1500);
        }
      }
      emitStatus();

      // 暂停检查点：在本轮「解禁成功」之后才允许挂起
      await waitWhilePaused();
      if (state.stopping) break;

      if (cfgLive.maxRounds > 0 && i >= cfgLive.maxRounds) {
        log("info", "达到最大轮数 " + cfgLive.maxRounds + "，自动停止");
        break;
      }
      await sleep(cfgLive.cycleIntervalMs);
      await waitWhilePaused();
    }

    state.paused = false;

    state.running = false;
    const summary = snapshot();
    post("stopped", summary);
    log("info", "循环结束：成功 " + state.okRounds + " 轮 / 失败 " + state.failRounds + " 轮");
    return summary;
  }

  /* ------------------------------------------------------------------ *
   * 控制接口
   * ------------------------------------------------------------------ */
  const api = {
    getState: snapshot,
    start(userCfg) {
      if (state.running) return { ok: false, reason: "already-running", state: snapshot() };
      cfgLive = Object.assign({}, DEFAULTS, userCfg || {});
      cfgLive.unbanDelayMs = clampUnbanDelay(cfgLive.unbanDelayMs); // 硬约束 ≤ 500ms，并预扣抖动余量
      loopPromise = loop().catch((e) => { log("err", "循环异常终止: " + (e && e.message)); });
      return { ok: true, state: snapshot() };
    },
    /** 暂停：一轮边界处挂起，计数与配置全部保留，可随时 resume */
    pause() {
      if (!state.running) return { ok: false, reason: "not-running", state: snapshot() };
      if (state.paused) return { ok: true, already: true, state: snapshot() };
      state.paused = true;
      state.pausedAt = now();
      log("info", "已暂停（当前轮执行完毕后挂起）");
      emitStatus();
      return { ok: true, state: snapshot() };
    },
    resume() {
      if (!state.running) return { ok: false, reason: "not-running", state: snapshot() };
      if (!state.paused) return { ok: true, already: true, state: snapshot() };
      state.paused = false;
      state.pausedAt = 0;
      log("info", "已继续");
      emitStatus();
      return { ok: true, state: snapshot() };
    },
    async stop() {
      if (!state.running) return { ok: true, state: snapshot() };
      state.stopping = true;
      state.paused = false;   // 解除挂起，让循环能走到退出分支
      if (loopPromise) await loopPromise;
      return { ok: true, state: snapshot() };
    },
    update(patch) {
      cfgLive = Object.assign({}, cfgLive, patch || {});
      log("info", "配置已热更新");
      emitStatus();
      return { ok: true, state: snapshot() };
    },
    /** 单次探测：查当前房间对目标 UID 的黑名单状态 */
    async probe(userCfg) {
      cfgLive = Object.assign({}, cfgLive, userCfg || {});
      const { roomId } = await fetchRemoteConfig();
      const d = await queryBanned(roomId, cfgLive.uid);
      return { ok: true, roomId, raw: d };
    },
    listRooms() { return { ok: true, roomId: resolveRoomId(), csrf: getCsrf() ? "present" : "missing" }; }
  };

  window[NS] = api;

  /* ------------------------------------------------------------------ *
   * 接收扩展侧指令
   * ------------------------------------------------------------------ */
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.channel !== CHANNEL || d.dir !== "ext") return;

    const reply = (payload) => post("ack", Object.assign({ req: d.type }, payload || {}));

    switch (d.type) {
      case "ping":
        reply({ ok: true, state: snapshot() });
        break;
      case "start":
        try { reply(api.start(d.payload)); } catch (e) { reply({ ok: false, reason: String(e.message || e) }); }
        break;
      case "stop":
        api.stop().then((r) => reply(r));
        break;
      case "pause":
        try { reply(api.pause()); } catch (e) { reply({ ok: false, reason: String(e.message || e) }); }
        break;
      case "resume":
        try { reply(api.resume()); } catch (e) { reply({ ok: false, reason: String(e.message || e) }); }
        break;
      case "update":
        reply(api.update(d.payload));
        break;
      case "probe":
        api.probe(d.payload).then((r) => reply(r)).catch((e) => reply({ ok: false, reason: String(e.message || e), code: e.biliCode }));
        break;
      case "listRooms":
        reply(api.listRooms());
        break;
      default:
        reply({ ok: false, reason: "unknown-type:" + d.type });
    }
  });

  post("ready", snapshot());
  log("info", "运行时已注入 MAIN world，房间号=" + (resolveRoomId() || "(未识别)") +
    " 登录态=" + (getCsrf() ? "OK" : "缺失 bili_jct"));
})();

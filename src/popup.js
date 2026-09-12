/**
 * popup.js — 控制面板逻辑。
 * 只负责：读写配置、下发指令、渲染状态。真正的循环在页面主世界运行。
 */

const $ = (id) => document.getElementById(id);

// 禁言理由（接口的 msg）已从面板移除：房管禁言不需要填理由，
// 接口也只把它当备注字段，runtime 统一提交空串（空串同时是解禁的语义标识）。
const FIELDS = {
  uid: "text",
  roomId: "text",
  unbanDelayMs: "int",
  cycleIntervalMs: "int",
  duration: "int",
  maxRounds: "int",
  useJson: "bool",
  waitForLive: "bool",
  autoStart: "bool"
};

let config = null;
let tabId = null;
let running = false;
let paused = false;
let pausedAt = 0;
let waitingLive = false;
let liveStatus = null;
let onLiveTab = false;
let tickTimer = null;
let lastRoundAt = 0;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, reason: chrome.runtime.lastError.message });
      else resolve(r || { ok: false, reason: "no-response" });
    });
  });
}

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function setHint(text, kind) {
  const h = $("hint");
  h.textContent = text || "";
  h.className = "hint" + (kind ? " " + kind : "");
}

function pushLog(level, text, t) {
  const li = document.createElement("li");
  li.className = level === "ok" ? "ok" : level === "err" ? "err" : "info";
  const time = document.createElement("time");
  time.textContent = fmtTime(t || Date.now());
  li.appendChild(time);
  li.appendChild(document.createTextNode(text));
  const ul = $("log");
  ul.insertBefore(li, ul.firstChild);
  while (ul.children.length > 80) ul.removeChild(ul.lastChild);
}

/* ------------------------------------------------------------------ *
 * 表单 ⇄ 配置
 * ------------------------------------------------------------------ */
function applyConfigToForm(c) {
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === "bool") el.checked = !!c[key];
    else el.value = c[key] == null ? "" : c[key];
  }
}

function readForm() {
  const out = {};
  for (const [key, kind] of Object.entries(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    if (kind === "bool") out[key] = !!el.checked;
    else if (kind === "int") out[key] = Number(el.value || 0);
    else out[key] = el.value.trim();
  }
  // 硬约束：需求要求 0.5s 内解禁
  out.unbanDelayMs = Math.min(500, Math.max(0, out.unbanDelayMs | 0));
  return out;
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = readForm();
    config = Object.assign({}, config, patch);
    const r = await bg({ cmd: "setConfig", config: patch });
    if (r && r.ok) config = r.config;
    if (running) await bg({ cmd: "update", payload: patch, tabId });
  }, 250);
}

/* ------------------------------------------------------------------ *
 * 状态渲染
 * ------------------------------------------------------------------ */
function renderState(state) {
  if (!state) return;
  running = !!state.running;
  paused = !!state.paused;
  pausedAt = state.pausedAt || 0;
  waitingLive = !!state.waitingLive;
  liveStatus = state.liveStatus == null ? null : Number(state.liveStatus);

  $("dot").className = "dot" +
    (waitingLive ? " waiting" : paused ? " paused" : running ? " on" : state.lastError ? " err" : "");
  $("sRounds").textContent = state.rounds || 0;
  $("sOk").textContent = state.okRounds || 0;
  $("sFail").textContent = state.failRounds || 0;
  $("sGap").textContent = state.lastRound && state.lastRound.unbanGapMs != null
    ? state.lastRound.unbanGapMs + "ms" : "—";

  $("btnStart").disabled = running;
  $("btnStop").disabled = !running;
  $("btnPause").disabled = !running;
  $("btnPause").textContent = paused ? "继续" : "暂停";

  if (waitingLive) {
    setHint("房间未开播 · 已进入等待，开播后自动开始循环（每 15s 探测一次）");
  } else if (paused) {
    setHint("已暂停 · 不再开始新的一轮（随时可点「继续」）");
  } else if (running) {
    setHint("循环运行中 · 房间 " + (state.roomId || "?") +
      (state.liveStatusText ? "（" + state.liveStatusText + "）" : "") +
      " · UID " + (state.uid || "?"));
  } else if (state.lastError) {
    setHint((state.lastError.message || "已停止") +
      (state.lastError.code != null ? "（code=" + state.lastError.code + "）" : ""), "err");
  } else if (state.rounds) {
    setHint("已停止 · 共执行 " + state.rounds + " 轮");
  }

  if (state.lastRound) {
    lastRoundAt = state.lastRound.at || Date.now();
  }
  refreshLiveBadge(state);
  ensureTicker();
}

/** 面板上方的房间状态角标 */
function refreshLiveBadge(state) {
  const el = $("sub");
  if (!el) return;
  const room = state && state.roomId ? state.roomId : "";
  const ls = state && state.liveStatus != null ? Number(state.liveStatus) : null;

  if (!onLiveTab) { el.textContent = "当前标签不是 B 站直播间"; el.className = "sub"; return; }
  if (ls === null) { el.textContent = "房间状态未知（点「探测」确认）"; el.className = "sub"; return; }

  const text = ls === 1 ? "直播中" : ls === 2 ? "轮播中" : "未开播";
  el.textContent = "房间 " + (room || "?") + " · " + text + (ls === 0 ? "（禁言接口不可用）" : "");
  el.className = "sub" + (ls === 0 ? " offline" : " live");
}

function ensureTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (waitingLive) {
      $("barFill").style.width = "100%";
      $("barFill").classList.add("waiting");
      return;
    }
    $("barFill").classList.remove("waiting");
    if (paused) {
      $("barFill").style.width = "100%";
      $("barFill").classList.add("paused");
      if (pausedAt) {
        const s = Math.floor((Date.now() - pausedAt) / 1000);
        $("hint").textContent = "已暂停 " + s + "s · 不再开始新的一轮（随时可点「继续」）";
      }
      return;
    }
    $("barFill").classList.remove("paused");
    const gap = config ? (config.cycleIntervalMs || 0) + (config.unbanDelayMs || 0) : 0;
    if (!running || !gap || !lastRoundAt) { $("barFill").style.width = running ? "100%" : "0"; return; }
    const p = Math.min(100, ((Date.now() - lastRoundAt) / gap) * 100);
    $("barFill").style.width = p.toFixed(1) + "%";
  }, 60);
}

/* ------------------------------------------------------------------ *
 * 动作
 * ------------------------------------------------------------------ */
async function start() {
  const cfg = readForm();
  if (!cfg.uid) { setHint("请先填写目标 UID", "err"); $("uid").focus(); return; }
  if (!/^\d+$/.test(String(cfg.uid))) { setHint("UID 必须是纯数字", "err"); return; }

  const r = await bg({ cmd: "setConfig", config: cfg });
  if (r && r.ok) config = r.config;

  // 已知未开播且未勾选等待时，直接给出原因，不再下发 start（避免日志里刷一串业务错误码）
  if (liveStatus === 0 && !cfg.waitForLive) {
    setHint("房间未开播：禁言接口不接受未开播房间的操作。勾选「未开播时等待开播」后会自动等待并开始。", "err");
    pushLog("err", "未开播（live_status=0），已阻止启动；勾选等待开播可自动接续");
    return;
  }

  $("btnStart").disabled = true;
  setHint("正在下发启动指令…");
  const res = await bg({ cmd: "start", payload: cfg, tabId });
  if (!res || !res.ok) {
    $("btnStart").disabled = false;
    setHint(res && res.reason ? res.reason : "启动失败（请确认已打开直播间页面）", "err");
    pushLog("err", "启动失败：" + (res && res.reason ? res.reason : "unknown"));
    return;
  }
  tabId = res.tabId || tabId;
  pushLog("info", "已向标签页下发 start（tab " + tabId + "）");
  setTimeout(refreshStatus, 300);
}

async function togglePause() {
  const want = paused ? "resume" : "pause";
  $("btnPause").disabled = true;
  const res = await bg({ cmd: want, tabId });
  if (!res || !res.ok) {
    $("btnPause").disabled = false;
    setHint((res && res.reason) || (want === "pause" ? "暂停失败" : "继续失败"), "err");
    return;
  }
  paused = want === "pause";
  if (!paused) pausedAt = 0;
  pushLog("info", paused ? "已暂停（当前轮结束后挂起）" : "已继续");
  await refreshStatus();
}

async function stop() {
  $("btnStop").disabled = true;
  const res = await bg({ cmd: "stop", tabId });
  if (!res || !res.ok) setHint(res && res.reason ? res.reason : "停止失败", "err");
  else pushLog("info", "已下发 stop");
  setTimeout(refreshStatus, 350);
}

async function probe() {
  const cfg = readForm();
  setHint("正在探测房间与禁言状态…");
  const res = await bg({ cmd: "probe", payload: cfg, tabId });
  if (res && res.ok === false) {
    setHint(res.reason || "探测失败", "err");
    pushLog("err", "探测失败：" + (res.reason || "unknown"));
    return;
  }

  const ls = res && res.liveStatus != null ? Number(res.liveStatus) : null;
  liveStatus = ls;
  if (res && res.roomId) $("roomId").value = res.roomId;

  if (ls === 0) {
    pushLog("err", "探测：房间 " + res.roomId + " 未开播 · 禁言接口不可用");
    setHint("房间未开播（" + res.roomId + "）：禁言接口不可用。" +
      (readForm().waitForLive ? "已勾选等待开播，点开始后会挂起等待。" : "可勾选「未开播时等待开播」后重试。"), "err");
  } else {
    const banned = res && res.banned;
    pushLog("info", "探测：房间 " + res.roomId + " · " + (res.liveStatusText || "状态未知") +
      " · 目标 UID " + (cfg.uid || "(未填)") +
      (banned === null || banned === undefined ? " · 未查询黑名单" : banned ? " · 在黑名单中" : " · 不在黑名单"));
    setHint("房间 " + res.roomId + " " + (res.liveStatusText || "") +
      (banned === null || banned === undefined ? "" : banned ? " · 目标 UID 已在黑名单" : " · 目标 UID 未在黑名单"), "ok");
  }
  refreshLiveBadge({ roomId: res.roomId, liveStatus: ls });
}

async function refreshStatus() {
  const r = await bg({ cmd: "getStatus", tabId });
  if (!r || r.ok === false) {
    if (r && r.reason) $("sub").textContent = r.reason;
    $("dot").className = "dot";
    return;
  }
  if (r.tabId) tabId = r.tabId;
  if (r.title) $("sub").textContent = r.title;
  if (r.state) renderState(r.state);
}

/* ------------------------------------------------------------------ *
 * 后台事件
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.from !== "bg") return;
  if (msg.evt === "status") { renderState(msg.payload); }  // 房间状态角标由 renderState 统一渲染
  else if (msg.evt === "round" && msg.payload) {
    lastRoundAt = msg.payload.at || Date.now();
    pushLog("ok", "第 " + msg.payload.index + " 轮完成 · 禁言 " + msg.payload.banMs +
      "ms · 解禁间隔 " + msg.payload.unbanGapMs + "ms · 单轮 " + msg.payload.totalMs + "ms", msg.payload.at);
    refreshStatus();
  } else if (msg.evt === "log" && msg.payload) {
    pushLog(msg.payload.level || "info", msg.payload.text || "", msg.payload.t);
  } else if (msg.evt === "stopped") {
    pushLog("info", "循环已停止");
    renderState(msg.payload);
  }
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
(async function init() {
  const v = chrome.runtime.getManifest().version;
  $("ver").textContent = " v" + v;

  const [cfgResp, tabs] = await Promise.all([
    bg({ cmd: "getConfig" }),
    chrome.tabs.query({ active: true, lastFocusedWindow: true })
  ]);
  config = cfgResp && cfgResp.config ? cfgResp.config : {};
  applyConfigToForm(config);

  const active = tabs && tabs[0];
  if (active) {
    tabId = active.id;
    onLiveTab = /live\.bilibili\.com/.test(active.url || "");
    $("sub").textContent = onLiveTab ? (active.title || "直播间") : "当前标签不是 B 站直播间";
    if (!config.roomId) {
      const m = (active.url || "").match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/);
      if (m) { $("roomId").value = m[1]; scheduleSave(); }
    }
  }

  for (const key of Object.keys(FIELDS)) {
    const el = $(key);
    if (!el) continue;
    el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input", scheduleSave);
  }
  $("btnStart").addEventListener("click", start);
  $("btnPause").addEventListener("click", togglePause);
  $("btnStop").addEventListener("click", stop);
  $("btnProbe").addEventListener("click", probe);

  ensureTicker();
  await refreshStatus();
  if (running) {
    pushLog("info", "检测到循环已在运行，恢复状态显示");
    setHint("循环运行中");
  } else if (onLiveTab) {
    // 打开面板即自动探一次房间状态：read-only 的 get_info，无副作用
    probe().catch(() => {});
  }
})();

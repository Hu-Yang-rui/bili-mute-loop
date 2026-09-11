/**
 * popup.js — 控制面板逻辑。
 * 只负责：读写配置、下发指令、渲染状态。真正的循环在页面主世界运行。
 */

const $ = (id) => document.getElementById(id);

const FIELDS = {
  uid: "text",
  roomId: "text",
  unbanDelayMs: "int",
  cycleIntervalMs: "int",
  msg: "text",
  duration: "int",
  maxRounds: "int",
  useJson: "bool",
  autoStart: "bool"
};

let config = null;
let tabId = null;
let running = false;
let paused = false;
let pausedAt = 0;
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

  $("dot").className = "dot" + (paused ? " paused" : running ? " on" : state.lastError ? " err" : "");
  $("sRounds").textContent = state.rounds || 0;
  $("sOk").textContent = state.okRounds || 0;
  $("sFail").textContent = state.failRounds || 0;
  $("sGap").textContent = state.lastRound && state.lastRound.unbanGapMs != null
    ? state.lastRound.unbanGapMs + "ms" : "—";

  $("btnStart").disabled = running;
  $("btnStop").disabled = !running;
  $("btnPause").disabled = !running;
  $("btnPause").textContent = paused ? "继续" : "暂停";

  if (paused) {
    setHint("已暂停 · 不再开始新的一轮（随时可点「继续」）");
  } else if (running) {
    setHint("循环运行中 · 房间 " + (state.roomId || "?") + " · UID " + (state.uid || "?"));
  } else if (state.lastError) {
    setHint("已停止（最近错误：" + (state.lastError.stage || "?") +
      (state.lastError.code != null ? " code=" + state.lastError.code : "") + "）", "err");
  } else if (state.rounds) {
    setHint("已停止 · 共执行 " + state.rounds + " 轮");
  }

  if (state.lastRound) {
    lastRoundAt = state.lastRound.at || Date.now();
  }
  ensureTicker();
}

function ensureTicker() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
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
  if (!cfg.uid) { setHint("请先填写目标 UID", "err"); return; }
  setHint("正在探测禁言状态…");
  const res = await bg({ cmd: "probe", payload: cfg, tabId });
  if (res && res.ok === false) {
    setHint(res.reason || "探测失败", "err");
    pushLog("err", "探测失败：" + (res.reason || "unknown"));
    return;
  }
  if (res && res.roomId) $("roomId").value = res.roomId;
  pushLog("info", "探测：房间 " + (res && res.roomId) + " · 返回 " +
    JSON.stringify(res && res.raw).slice(0, 240));
  setHint("探测完成：房间 " + (res && res.roomId) + "，详见日志", "ok");
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
  if (msg.evt === "status") { $("sub").textContent = "直播间已连接"; renderState(msg.payload); }
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
    $("sub").textContent = /live\.bilibili\.com/.test(active.url || "")
      ? (active.title || "直播间")
      : "当前标签不是 B 站直播间";
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
  }
})();

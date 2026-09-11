/**
 * background.js — MV3 service worker。
 *
 * 只做三件事：
 *   1. 维护默认配置 & 会话状态（chrome.storage.local）。
 *   2. 在 popup 与标签页内容脚本之间转发控制指令。
 *   3. 标签页导航/关闭时清理陈旧状态。
 *
 * 真正的循环逻辑跑在直播间页面主世界（src/runtime.js），
 * 这样即使 service worker 被回收，循环也不会中断。
 */

const DEFAULT_CONFIG = {
  uid: "",
  roomId: "",
  onlyRoom: "",          // 仅在该房间自动启动；留空 = 所有直播间
  unbanDelayMs: 300,     // 禁言成功 → 解禁 的间隔（硬上限 500）
  cycleIntervalMs: 800,  // 轮与轮之间的间隔
  msg: "接口联调测试",   // 禁言理由：仅随禁言请求提交，解禁时置空；扩展不会把它发到聊天框
  mtype: 1,
  duration: 0,
  useJson: false,
  apiBase: "https://api.live.bilibili.com",
  maxRounds: 0,
  retry: 3,
  retryDelayMs: 250,
  autoStart: false
};

const sessions = new Map(); // tabId -> { state, updatedAt, href }

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get({ config: null });
  if (!config) await chrome.storage.local.set({ config: DEFAULT_CONFIG });
  await chrome.storage.local.set({ installedAt: Date.now(), version: chrome.runtime.getManifest().version });
});

/** 找到当前活动的直播间标签页（优先活动标签，其次任意匹配标签） */
async function findLiveTab(preferTabId) {
  if (preferTabId != null) {
    const t = await chrome.tabs.get(preferTabId).catch(() => null);
    if (t && /live\.bilibili\.com/.test(t.url || "")) return t;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && /live\.bilibili\.com/.test(active.url || "")) return active;
  const all = await chrome.tabs.query({ url: "https://live.bilibili.com/*" });
  return all[0] || null;
}

function sendToPage(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, reason: chrome.runtime.lastError.message });
      else resolve(resp || { ok: true });
    });
  });
}

async function handle(msg, sender) {
  switch (msg.cmd) {
    case "getConfig": {
      const { config } = await chrome.storage.local.get({ config: DEFAULT_CONFIG });
      return { ok: true, config: Object.assign({}, DEFAULT_CONFIG, config) };
    }

    case "setConfig": {
      const { config } = await chrome.storage.local.get({ config: DEFAULT_CONFIG });
      const next = Object.assign({}, DEFAULT_CONFIG, config, msg.config || {});
      next.unbanDelayMs = Math.min(500, Math.max(0, Number(next.unbanDelayMs) || 0));
      await chrome.storage.local.set({ config: next });
      return { ok: true, config: next };
    }

    case "start":
    case "stop":
    case "probe":
    case "update": {
      const tab = await findLiveTab(msg.tabId);
      if (!tab) return { ok: false, reason: "未找到已打开的 B 站直播间标签页" };
      const r = await sendToPage(tab.id, { target: "page", cmd: msg.cmd, payload: msg.payload });
      if (r && r.ok === false && /Receiving end does not exist/.test(r.reason || "")) {
        // 内容脚本尚未注入（例如扩展刚安装、页面未刷新）
        return { ok: false, reason: "内容脚本未就绪，请刷新直播间页面后重试", tabId: tab.id };
      }
      return Object.assign({ tabId: tab.id, title: tab.title }, r);
    }

    case "getStatus": {
      const tab = await findLiveTab(msg.tabId);
      if (!tab) return { ok: false, reason: "未打开直播间" };
      const r = await sendToPage(tab.id, { target: "page", cmd: "getStatus" });
      const cached = sessions.get(tab.id);
      return Object.assign({ tabId: tab.id, cached }, r);
    }

    case "pageReport": {
      const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
      if (tabId != null) {
        sessions.set(tabId, {
          state: msg.payload,
          updatedAt: Date.now(),
          href: msg.href,
          pageType: msg.pageType
        });
        await chrome.storage.local.set({ lastState: msg.payload, lastStateAt: Date.now() });
      }
      return { ok: true };
    }

    default:
      return { ok: false, reason: "unknown-cmd:" + msg.cmd };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.cmd) { sendResponse({ ok: false, reason: "empty" }); return false; }
  if (msg.from === "page") {
    // 页面状态上报：静默处理，并把最新状态广播给 popup
    handle({ cmd: "pageReport", ...msg }, sender).then(() => {
      if (msg.pageType === "status" || msg.pageType === "round" || msg.pageType === "stopped" || msg.pageType === "log") {
        chrome.runtime.sendMessage({ from: "bg", evt: msg.pageType, payload: msg.payload }).catch(() => {});
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  handle(msg, sender).then(sendResponse).catch((e) => sendResponse({ ok: false, reason: String(e && e.message || e) }));
  return true; // async response
});

chrome.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) sessions.delete(tabId);
});

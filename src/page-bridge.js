/**
 * page-bridge.js — 内容脚本（ISOLATED world）。
 *
 * 职责：
 *   1. 把 runtime.js 以 <script src=chrome.runtime.getURL(...)> 注入页面主世界
 *      （web_accessible_resources 已在 manifest 中声明）。
 *   2. 在页面 postMessage 与 chrome.runtime 消息之间做双向桥接。
 *   3. runtime 就绪后，按已保存配置自动启动循环（autoStart=true 时）。
 *
 * 注意：content script 本身不直接调用禁言接口，只做注入与转发。
 */

(function () {
  "use strict";

  const CHANNEL = "BML_LOOP";
  const SRC_TAG = "bml-loop-runtime";
  const storage = chrome.storage.local;

  let lastState = null;
  let autoStarted = false;

  /* ---------------- 注入主世界 runtime ---------------- */
  function injectRuntime() {
    if (document.getElementById(SRC_TAG)) return;
    const el = document.createElement("script");
    el.id = SRC_TAG;
    el.src = chrome.runtime.getURL("src/runtime.js");
    el.type = "text/javascript";
    (document.head || document.documentElement).appendChild(el);
    el.onload = () => el.remove();
  }

  /* ---------------- 页面 → 扩展 ---------------- */
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.channel !== CHANNEL || d.dir !== "page") return;

    if (d.type === "status" || d.type === "ready" || d.type === "stopped" || d.type === "ack") {
      lastState = d.payload || lastState;
    }

    try {
      chrome.runtime.sendMessage({
        from: "page",
        pageType: d.type,
        payload: d.payload,
        href: location.href
      }, () => void chrome.runtime.lastError);
    } catch (_) { /* extension context invalidated */ }

    if (d.type === "ready") maybeAutoStart(d.payload);
  });

  /* ---------------- 扩展 → 页面 ---------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "page") return;

    if (msg.cmd === "getStatus") {
      // 主动 ping 一次主世界，拿最新状态回给 popup
      const onAck = (ev) => {
        const d = ev.data;
        if (!d || d.channel !== CHANNEL || d.dir !== "page" || d.type !== "ack") return;
        if (d.payload && d.payload.req === "ping") {
          window.removeEventListener("message", onAck);
          sendResponse({ ok: true, state: d.payload.state, href: location.href });
        }
      };
      window.addEventListener("message", onAck);
      window.postMessage({ channel: CHANNEL, dir: "ext", type: "ping" }, "*");
      setTimeout(() => { window.removeEventListener("message", onAck); sendResponse({ ok: true, state: lastState, href: location.href, timeout: true }); }, 600);
      return true; // async
    }

    window.postMessage({ channel: CHANNEL, dir: "ext", type: msg.cmd, payload: msg.payload }, "*");
    sendResponse({ ok: true, forwarded: msg.cmd });
    return false;
  });

  /* ---------------- 自动启动 ---------------- */
  async function maybeAutoStart(pageState) {
    if (autoStarted) return;
    autoStarted = true;
    const { config } = await storage.get({ config: null });
    if (!config || !config.autoStart) return;
    if (!config.uid) return;
    if (pageState && pageState.running) return;
    if (config.onlyRoom && String(config.onlyRoom) !== String(pageState && pageState.roomId)) return;

    setTimeout(() => {
      window.postMessage({ channel: CHANNEL, dir: "ext", type: "start", payload: config }, "*");
    }, 1200); // 等直播间自身初始化完成
  }

  injectRuntime();
})();

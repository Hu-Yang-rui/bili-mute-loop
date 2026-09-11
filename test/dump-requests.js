/**
 * test/dump-requests.js — 打印两种操作实际发出的请求体，用于核对「禁言理由」字段。
 *
 * 运行： node test/dump-requests.js
 *
 * 它用与 harness.js 相同的沙箱跑真实 runtime.js，只是把 fetch 收到的
 * 请求体原样打印出来，便于肉眼确认：
 *   - 禁言：msg = 面板填写的理由，duration = 面板填写的时长
 *   - 解禁：msg = 空串，duration = 0
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "src", "runtime.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CFG = {
  uid: "10086",
  roomId: "21452505",
  unbanDelayMs: 50,
  cycleIntervalMs: 40,
  msg: "循环联调测试",   // ← 面板「禁言理由」对应这个字段
  mtype: 1,
  duration: 0,          // ← 面板「禁言时长」
  useJson: false,
  maxRounds: 1,
  retry: 0,
  retryDelayMs: 10
};

const listeners = [];
const seen = [];
const win = {
  __BML_CONFIG__: CFG,
  document: { cookie: "bili_jct=FAKE_CSRF_TOKEN", getElementById: () => null, head: { appendChild() {} } },
  location: { pathname: "/21452505", href: "https://live.bilibili.com/21452505" },
  addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); },
  removeEventListener: () => {},
  postMessage: (d) => {
    if (d && d.dir === "ext") for (const fn of listeners) fn({ source: win, data: d });
  }
};

const fetchImpl = async (url, init) => {
  seen.push({
    t: new Date().toISOString().slice(11, 23),
    method: (init && init.method) || "GET",
    path: url.replace("https://api.live.bilibili.com", ""),
    contentType: init && init.headers && init.headers["Content-Type"],
    body: init && init.body
  });
  await sleep(8);
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

(async () => {
  win.__BML_LOOP__.start(CFG);
  await sleep(500);
  await win.__BML_LOOP__.stop();

  const dec = (body) => {
    if (!body) return "(无 body)";
    const p = new URLSearchParams(body);
    const out = {};
    for (const [k, v] of p.entries()) out[k] = v;
    return JSON.stringify(out, null, 0)
      .replace(/"msg":""/, '"msg":""   ← 空串：解禁')
      .replace(/"msg":"([^"]+)"/, '"msg":"$1"   ← 理由：禁言');
  };

  console.log("一次完整循环实际发出的请求：\n");
  seen.forEach((s, i) => {
    const isUnban = s.body && new URLSearchParams(s.body).get("msg") === "";
    console.log(`  [${i + 1}] ${s.t}  ${s.method} ${s.path}`);
    console.log(`      内容类型: ${s.contentType}`);
    console.log(`      标签    : ${isUnban ? "解禁（msg 为空串）" : "禁言（msg = 面板填写的理由）"}`);
    console.log(`      请求体  : ${dec(s.body)}`);
    console.log("");
  });

  const unban = seen.find((s) => s.body && new URLSearchParams(s.body).get("msg") === "");
  const ban = seen.find((s) => s.body && new URLSearchParams(s.body).get("msg") !== "");
  console.log("结论：");
  console.log(`  禁言 msg      = ${JSON.stringify(ban && new URLSearchParams(ban.body).get("msg"))}  （面板填写的「禁言理由」）`);
  console.log(`  解禁 msg      = ${JSON.stringify(unban && new URLSearchParams(unban.body).get("msg"))}  （必须为空，否则会被后端当成再次禁言）`);
  console.log(`  解禁 duration = ${JSON.stringify(unban && new URLSearchParams(unban.body).get("duration"))}`);
})();

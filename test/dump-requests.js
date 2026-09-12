/**
 * test/dump-requests.js — 打印一次完整循环实际发出的全部请求。
 *
 * 运行： node test/dump-requests.js
 *
 * 它用与 harness.js 相同的沙箱跑真实 runtime.js，把 fetch 收到的请求原样打印，
 * 便于核对这些事实：
 *   - 循环开始前会先探测一次房间开播状态（get_info，read-only）；
 *   - 禁言与解禁共用 room_silence，靠 msg 是否为空 + duration 区分动作；
 *   - 房管禁言不需要理由，两个动作的 msg 都提交空串。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "..", "src", "runtime.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CFG = {
  uid: "10086",
  roomId: "21452505",
  unbanDelayMs: 60,
  cycleIntervalMs: 40,
  mtype: 1,
  duration: 0,
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
  const kind = url.includes("/room/v1/Room/get_info") ? "get_info"
    : url.includes("room_silence") ? "room_silence"
    : url.includes("QueryBlackListUser") ? "QueryBlackListUser"
    : "其他";
  seen.push({
    t: new Date().toISOString().slice(11, 23),
    kind,
    method: (init && init.method) || "GET",
    path: url.replace("https://api.live.bilibili.com", ""),
    contentType: init && init.headers && init.headers["Content-Type"],
    body: init && init.body
  });
  await sleep(8);
  if (kind === "get_info") {
    return {
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { room_id: 21452505, live_status: 1 } })
    };
  }
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

const pretty = (body) => {
  if (!body) return "(无 body)";
  const p = new URLSearchParams(body);
  const o = {};
  for (const k of ["room_id", "banned_uid", "msg", "mtype", "duration", "csrf"]) {
    if (p.has(k)) o[k] = p.get(k) === "" ? "（空串）" : p.get(k);
  }
  return JSON.stringify(o);
};

(async () => {
  const api = win.__BML_LOOP__;
  api.start(CFG);
  for (let i = 0; i < 40 && api.getState().running; i++) await sleep(50);

  console.log("一次完整循环实际发出的请求：\n");
  seen.forEach((s, i) => {
    const label = s.kind === "get_info" ? "探测房间开播状态（前置检查 · read-only）"
      : s.kind === "QueryBlackListUser" ? "查询禁言状态（read-only）"
      : "写入操作（禁言 / 解禁）";
    console.log(`  [${i + 1}] ${s.t}  ${s.method} ${s.path}`);
    console.log(`      用途    : ${label}`);
    if (s.contentType) console.log(`      内容类型: ${s.contentType}`);
    console.log(`      请求体  : ${pretty(s.body)}`);
    console.log("");
  });

  const writes = seen.filter((s) => s.kind === "room_silence");
  const ban = writes[0];
  const unban = writes[1];
  const g = (r, k) => (r && r.body ? new URLSearchParams(r.body).get(k) : undefined);

  console.log("结论：");
  console.log(`  写操作次数    : ${writes.length}（每轮 = 1 次禁言 + 1 次解禁）`);
  console.log(`  禁言 msg      : ${JSON.stringify(g(ban, "msg"))}`);
  console.log(`  解禁 msg      : ${JSON.stringify(g(unban, "msg"))}`);
  console.log(`  解禁 duration : ${JSON.stringify(g(unban, "duration"))}`);
  console.log("  依据          : room_silence 靠 msg 是否为空 + duration 区分动作；");
  console.log("                  房管禁言不需要理由，故两个动作都提交空串 msg。");
})();

# B站直播 禁言 / 解禁 循环助手（Chrome MV3 扩展）

对指定 UID 在直播间内执行 **禁言 → 0.5s 内解除禁言 → 循环** 的自动化扩展。

![Manifest](https://img.shields.io/badge/Manifest-V3-4285F4)
![Chrome](https://img.shields.io/badge/Chrome-%E2%89%A5%20111-34A853)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Test](https://img.shields.io/badge/test-harness.js%20%2B%20harness--pause.js-brightgreen)

## 用途与边界

**用途**：房管权限接口联调、自动化回归、权限链路压测、时序验证。

**请自行保证**：仅在你**实际拥有房管权限**的直播间内使用，并遵守 B 站用户协议与直播间管理规定。
本工具不绕过任何权限校验 —— 它只是把你在网页上手动能点的操作循环化，
每次调用能否成功完全由你本人登录态的权限决定。

**明确不做**：批量/自动识别目标、对无权限的房间操作、对抗风控或封禁机制的改造。

---

## 一、目录结构

```
bili-mute-loop/
├─ manifest.json          # MV3 清单：权限 / 内容脚本 / 可访问资源
├─ src/
│  ├─ runtime.js          # 主世界执行体：真正的禁言/解禁循环引擎
│  ├─ page-bridge.js      # 内容脚本：注入 runtime + 消息桥接 + 自动启动
│  ├─ background.js       # service worker：配置持久化 + 指令转发
│  ├─ popup.html/.css/.js # 控制面板 UI
├─ test/
│  ├─ harness.js          # 循环时序仿真测试
│  └─ harness-pause.js    # 暂停 / 继续语义测试
├─ LICENSE
└─ README.md
```

## 二、安装

1. 打开 `chrome://extensions/`。
2. 右上角开启 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 的文件夹）。
4. **刷新已打开的 B 站直播间页面**（内容脚本只在页面加载时注入）。

要求 Chrome ≥ 111（`world: "MAIN"` 相关能力）。

## 三、使用

1. 登录 B 站，进入你**有房管权限**的直播间 `https://live.bilibili.com/<房间号>`。
2. 点击工具栏扩展图标打开面板：
   - **目标 UID**：要禁言的用户（必填，纯数字）。
   - **房间号**：留空则自动读取当前直播间内置 `room_id`。
   - **禁言 → 解禁 延迟**：默认 `300ms`，硬上限 `500ms`（对应需求“0.5 秒内解禁”）。
   - **周期间隔**：一轮完成后到下一轮开始的间隔，默认 `800ms`。
   - **最大轮数**：`0` = 无限循环。
   - **接口请求体**：`form-urlencoded`（默认）或 `application/json`。
   - **自动启动**：勾选后，进入直播间会自动按当前配置开始循环。
3. 点 **开始循环**。面板实时显示轮次 / 成功 / 失败 / 实际解禁间隔。
4. 点 **暂停 / 继续** 临时挂起或恢复（见下节）。
5. 点 **停止** 结束循环（会在当前轮结束后退出，不会留下“已禁言未解禁”的中间态）。

### 暂停 / 继续

面板中间的 **暂停** 按钮让循环挂起，按钮随即变成 **继续**：

- **一轮边界挂起**：点暂停时，正在执行的那一轮会先跑完（禁言 → 解禁），之后不再开始新一轮。
  所以暂停不会把任何人留在“已禁言”状态，被禁言的最长时间就是一轮的 `unbanDelayMs`（≤500ms）。
- **状态保留**：暂停期间 `running` 仍为 `true`，轮次 / 成功 / 失败计数和配置全部保留；面板指示灯转为黄色，
  进度条变黄并显示已暂停秒数。
- **随时继续**：点 **继续** 立刻从下一轮接着跑，计数继续累加，不需要重新填参数。
- **暂停中也能停止**：`stop()` 会先解除挂起再退出，不会卡在等待循环里（已有测试覆盖）。
- **快捷键思路**：暂停状态保存在页面主世界，关闭 popup 再打开仍是暂停状态；直接关掉直播间标签页等于强制结束。

等价的控制方式（不依赖 popup）：

```js
// 在直播间页面的控制台执行（页面上下文）
__BML_LOOP__.pause();    // 暂停
__BML_LOOP__.resume();   // 继续
__BML_LOOP__.stop();     // 停止
__BML_LOOP__.getState(); // 查看 { running, paused, rounds, okRounds, failRounds, ... }
```

## 四、核心接口（runtime.js）

| 动作 | 方法与路径 |
| --- | --- |
| 禁言 | `POST {apiBase}/xroom/v1/Room/room_silence` |
| 解禁 | `POST {apiBase}/xroom/v1/Room/room_silence`，`duration=0` / `msg=""` |
| 查询状态 | `GET {apiBase}/xlive/web-ucenter/v1/banned/QueryBlackListUser?room_id=&uid=` |

请求体字段（两个动作共用）：

```
room_id    直播间房间号
banned_uid 目标用户 UID
msg        禁言理由（解禁时为空）
mtype      1 = 直播间禁言
duration   禁言时长（秒），0 = 解除禁言 / 默认时长
csrf       取自 cookie bili_jct
```

`csrf` 每次请求前从 `document.cookie` 动态读取，避免页面长时间停留后 token 失效。所有请求带 `credentials: "include"`，复用页面登录态。

## 五、时序与硬性保证

```
t0 ── 发送禁言请求 ──► t1 收到 code:0
                          │
                          ├─ sleep(unbanDelayMs)   // 默认 300ms，上限 500ms
                          ▼
t2 ── 发送解禁请求 ──► t3 收到 code:0
                          │
                          └─ sleep(cycleIntervalMs) → 下一轮
```

- **t2 − t1 ≤ 500ms**：在 `start()` 与 `saveConfig` 两处都做了 `Math.min(500, …)` 夹紧，配置无法绕过。
- 定时的实现细节：`sleepUntil(deadline)` 按**绝对时间点**自校正（提前醒来就补睡），并且用户配置值会**预扣 45ms 抖动余量**（`UNBAN_SAFETY_MS`）。原因是浏览器定时器有 1–16ms 抖动，加上一次事件循环 tick 与 fetch 派发开销合计可达 40ms+；若直接 `setTimeout(500)`，实测端到端间隔会跑到 503–530ms 而越过约束。所以配置 `300ms` 时，实测间隔约 300ms，而配置上限 `500ms` 时实测约 480ms。
- 面板上的 **解禁间隔** 显示的是真实测量的 `unbanGapMs`，可直接验证是否满足 0.5s 约束。
- 若禁言请求失败，本轮**不会**发解禁请求（避免无意义请求），并计入失败轮次。

## 六、本地自测（无需浏览器）

`test/harness.js` 用 `vm` 在 Node 里 mock 出 `window / document / cookie / fetch`，
直接跑真实的 `src/runtime.js`，验证循环时序与请求体：

```bash
node test/harness.js
```

覆盖点：

- 3 轮循环按序完成，且顺序恒为 `禁言 → 解禁`（不留“已禁言未解禁”的中间态）；
- 实测 `禁言→解禁` 间隔 ≤ 500ms；
- `-509`（限频）按指数退避重试后成功；
- `unbanDelayMs=999` 被夹紧（含 45ms 余量后为 455ms）；
- 请求体字段：`csrf` 取自 `bili_jct`、`banned_uid`、`room_id`、解禁时 `msg=""` 且 `duration=0`。

`test/harness-pause.js` 专门验证暂停语义：

```bash
node test/harness-pause.js
```

- 暂停最多让在途的 1 轮跑完，之后计数完全冻结；
- 暂停期间 `running` 仍为 `true` 且会上报 `paused` 状态；
- `resume` 后计数继续累加；
- 暂停状态下 `stop()` 能正常退出（不卡死），且不多跑轮次；
- `postMessage` 协议 `pause` / `resume` 能正确回 ack。

最近一次运行结果：

```
[PASS] 每轮 禁言→解禁 间隔 ≤ 500ms  → 466, 468, 465 ms
[PASS] 每对 禁言→解禁 间隔 ≤ 500ms  → 484, 484, 481 ms
[PASS] 解禁请求 msg 为空且 duration=0（不会被误判为再次禁言）
全部通过 ✅

[PASS] 挂起后 900ms 内没有开始新一轮  → 4 → 4
[PASS] 暂停状态下 stop() 能正常退出（<3s）  → 耗时 65ms，running=false
暂停/继续 全部通过 ✅
```

## 七、稳定性设计

1. **循环跑在页面主世界**：service worker 随时可能被回收，把循环放在页面上下文后，MV3 的 SW 生命周期不影响循环连续性；关闭 popup 也不影响。
2. **重试与退避**：`-412`（风控）/ `-509`（限频）/ 网络异常按 `retryDelayMs × 2^n` 指数退避重试，默认 3 次。
3. **风控节流**：命中 `-412/-509/-101` 时额外退避 1500ms 再进入下一轮。
4. **重复注入防护**：`window.__BML_LOOP_INSTALLED__` 与 script 标签 id 双重判重，popup 与 bridge 同时注入也只生效一份。
5. **状态可观测**：主世界通过 `postMessage`（channel `BML_LOOP`）上报 `ready / status / round / log / stopped`，popup 与 background 双向转发，popup 重开后可恢复显示运行中状态。
6. **热更新**：循环运行中修改面板配置会通过 `update` 指令即时生效，无需重启循环。

## 八、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `内容脚本未就绪，请刷新直播间页面后重试` | 刚安装/重载扩展后页面未刷新，刷新直播间即可。 |
| `未取到 bili_jct（请先在该浏览器登录 B 站）` | 未登录或 cookie 被清理，重新登录。 |
| `code=-101` 未登录 / `-403` 无权限 | 当前账号在该房间没有房管权限。 |
| `code=-412` 请求被拦截 | 触发风控，降低频率（加大周期间隔/延迟），或稍后重试。 |
| `code=-509` 请求过于频繁 | 同上。 |
| 解禁返回业务错误 | 部分房间对「禁言后立即解禁」有后端保护窗口，此时会按退避重试；可通过加大 `unbanDelayMs`（≤500ms）缓解。 |
| 探测按钮无返回 | 需要先打开直播间标签页。 |

## 九、建议的调参基线

| 场景 | unbanDelayMs | cycleIntervalMs | maxRounds |
| --- | --- | --- | --- |
| 功能验证 | 300 | 800 | 5 |
| 稳定性观察 | 400 | 1500 | 50 |
| 长稳压测 | 500 | 3000 | 0 |

频率越高越容易触发 `-412`；建议从“功能验证”档起步，确认接口与权限链路正常后再放大。

## 十、许可证与免责声明

本项目以 **MIT License** 发布，详见 [LICENSE](./LICENSE)。

软件按“原样”提供，不附带任何明示或暗示的担保。
使用者需自行确保其使用行为符合 B 站用户协议、直播间管理规定及所在地法律法规；
因使用本软件产生的一切后果由使用者自行承担。

---

## 十一、开发与贡献

```bash
git clone https://github.com/Hu-Yang-rui/bili-mute-loop.git
cd bili-mute-loop
node test/harness.js        # 循环时序
node test/harness-pause.js  # 暂停 / 继续
```

修改 `src/` 后在 `chrome://extensions/` 点扩展的刷新按钮，再刷新直播间页面即可生效。
欢迎提 Issue / PR（尤其是不同房间的接口返回差异与风控阈值实测数据）。

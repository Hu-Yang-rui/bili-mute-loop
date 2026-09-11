<h1 align="center">B站直播间 禁言 / 解禁 循环助手</h1>

<p align="center">
  <a href="https://github.com/Hu-Yang-rui/bili-mute-loop/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/Hu-Yang-rui/bili-mute-loop?label=release&color=FB7299&logo=github&logoColor=white"></a>
  <a href="https://github.com/Hu-Yang-rui/bili-mute-loop/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/Hu-Yang-rui/bili-mute-loop/total?label=downloads&logo=github&logoColor=white"></a>
  <a href="https://github.com/Hu-Yang-rui/bili-mute-loop/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Hu-Yang-rui/bili-mute-loop/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Hu-Yang-rui/bili-mute-loop/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/Hu-Yang-rui/bili-mute-loop?label=license"></a>
  <a href="https://github.com/Hu-Yang-rui/bili-mute-loop"><img alt="Stars" src="https://img.shields.io/github/stars/Hu-Yang-rui/bili-mute-loop?label=stars&logo=github&logoColor=white&color=e3b341"></a>
  <a href="https://github.com/Hu-Yang-rui/bili-mute-loop/search?l=javascript"><img alt="Language" src="https://img.shields.io/github/languages/top/Hu-Yang-rui/bili-mute-loop?label=language&logo=javascript&logoColor=black"></a>
  <a href="#-下载安装"><img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white"></a>
  <a href="#-下载安装"><img alt="Chrome" src="https://img.shields.io/badge/Chrome-%E2%89%A5%20111-34A853?logo=googlechrome&logoColor=white"></a>
</p>

<p align="center">
  <b>一个 Chrome MV3 扩展：在 B 站直播间对指定 UID 循环执行「禁言 → 0.5 秒内解除禁言」</b><br>
  <sub>面向房管权限接口联调、时序验证与内容审核链路压测 · 本地运行 · 无服务端 · 无遥测</sub>
</p>

<p align="center">
  <a href="#-下载安装"><b>下载安装</b></a> ·
  <a href="#-功能特性"><b>功能特性</b></a> ·
  <a href="#-工作原理"><b>工作原理</b></a> ·
  <a href="#-测试验证"><b>测试验证</b></a> ·
  <a href="#-边界说明"><b>边界说明</b></a>
</p>

---

## 📖 项目简介

`bili-mute-loop` 把直播间管理端"先禁言、再立刻解禁"这一操作序列自动化，并保证两步之间的间隔稳定落在 **500 ms 以内**。

它不做任何权限绕过：扩展直接复用当前浏览器已登录的直播间会话，通过与页面手动操作完全相同的接口发起请求。因此**能否执行完全取决于账号在该房间是否具备房管权限**——没有权限的账号，扩展与手动点击的结果一致，都是失败。

| 维度 | 说明 |
| --- | --- |
| 运行形态 | Chrome 扩展（Manifest V3），本地加载，不依赖任何后端服务 |
| 数据流向 | 请求直接发往 `api.live.bilibili.com`，配置仅存于 `chrome.storage.local` |
| 遥测 | 无。不采集、不上报任何数据 |
| 依赖 | 运行时零第三方依赖 |
| 许可证 | MIT |

适用场景：房管权限接口的回归联调、禁言/解禁时序与限频阈值实测、审核操作链路的稳定性观察。

## ✨ 功能特性

| 特性 | 实现方式 |
| --- | --- |
| 按 UID 指定目标 | 面板填写目标 UID 与房间号，纯数字校验 |
| 禁言 → 解禁 ≤ 500ms | 双处配置夹紧 + 绝对时间点自校正 + 45ms 抖动余量预扣 |
| 循环执行 | 可设周期间隔；`最大轮数 = 0` 表示无限循环 |
| 暂停 / 继续 | 一轮边界挂起，计数与配置保留，不遗留"已禁言未解禁"状态 |
| 失败重试 | `-412` 风控 / `-509` 限频 / 网络异常按 `retryDelayMs × 2ⁿ` 指数退避 |
| 状态可观测 | 面板实时显示轮次、成功、失败、实测解禁间隔与滚动日志 |
| 自动启动 | 可选：进入直播间后按已保存配置自动开始 |
| 页面内 API | 主世界暴露 `__BML_LOOP__.pause() / resume() / stop() / getState()` |

## 🚀 下载安装

### 方式一：直接下载打包文件（推荐）

1. 打开 [**Releases · 最新版本**](https://github.com/Hu-Yang-rui/bili-mute-loop/releases/latest)，下载 `bili-mute-loop-v1.0.0.zip`
2. 解压到任意目录（例如 `D:\extensions\bili-mute-loop`）
3. 浏览器打开 `chrome://extensions/`，右上角开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择第 2 步解压出的目录
5. **刷新已打开的 B 站直播间页面**（内容脚本仅在页面加载时注入）

> 稳定直链：`https://github.com/Hu-Yang-rui/bili-mute-loop/releases/latest/download/bili-mute-loop-v1.0.0.zip`
>
> 版本号会随 Release 更新，长期使用建议以 Release 页面为准。

### 方式二：源码加载

```bash
git clone https://github.com/Hu-Yang-rui/bili-mute-loop.git
```

克隆后按上面第 3–5 步加载 `bili-mute-loop` 目录即可。

**环境要求**：Chrome ≥ 111（依赖 MV3 在主世界注入脚本的能力）。

## 🕹 使用说明

1. 在浏览器中登录 B 站，进入**具备房管权限**的直播间 `https://live.bilibili.com/<房间号>`
2. 点击工具栏扩展图标打开控制面板，填写配置：

| 面板字段 | 说明 |
| --- | --- |
| 目标 UID | 必填，纯数字 |
| 房间号 | 留空则自动读取当前页面内置的 `room_id` |
| 禁言 → 解禁延迟 | 默认 `300ms`，**上限 500ms**（超出会被自动夹紧） |
| 周期间隔 | 一轮结束后到下一轮开始的等待时间，默认 `800ms` |
| 禁言理由 | 即接口的 `msg` 字段，写入平台侧操作记录，供主播与房管查看。**仅在禁言时发送；解禁请求该字段必须为空串**，否则后端会当成一次新的禁言 |
| 禁言时长 | 即接口的 `duration`，单位秒；`0` 表示按房间默认时长 |
| 最大轮数 | `0` = 无限循环 |
| 接口请求体 | `form-urlencoded`（默认）或 `application/json` |
| 自动启动 | 进入直播间后按当前配置自动开始循环 |

3. 点击 **开始循环**，面板实时显示轮次 / 成功 / 失败 / 实测解禁间隔
4. 点击 **暂停 / 继续** 临时挂起或恢复
5. 点击 **停止** 结束循环（当前轮结束后退出，不留中间态）

### 暂停 / 继续

- **一轮边界挂起**：点击暂停时，正在执行的那一轮会先跑完（禁言 → 解禁），之后不再开始新一轮。因此暂停不会把任何用户留在"已禁言"状态，被禁言的最长时间即一轮的 `unbanDelayMs`（≤ 500ms）。
- **状态保留**：暂停期间 `running` 仍为 `true`，轮次与计数、配置全部保留；面板指示灯转黄并显示已暂停秒数。
- **随时继续**：点击继续立刻从下一轮接续，计数继续累加，无需重新填写参数。
- **暂停中亦可停止**：`stop()` 会先解除挂起再退出，不会卡在等待循环中（已由测试覆盖）。

### 不依赖面板的控制方式

在直播间页面的控制台（页面上下文）中执行：

```js
__BML_LOOP__.pause();     // 暂停
__BML_LOOP__.resume();    // 继续
__BML_LOOP__.stop();      // 停止
__BML_LOOP__.getState();  // { running, paused, rounds, okRounds, failRounds, ... }
```

## 🔧 工作原理

### 接口

| 动作 | 方法与路径 |
| --- | --- |
| 禁言 | `POST {apiBase}/xroom/v1/Room/room_silence` |
| 解禁 | `POST {apiBase}/xroom/v1/Room/room_silence`，`duration=0` 且 `msg=""` |
| 查询状态 | `GET {apiBase}/xlive/web-ucenter/v1/banned/QueryBlackListUser?room_id=&uid=` |

禁言与解禁共用同一入口，请求体字段：

```
room_id     直播间房间号（URL 为短号时自动经 get_info 换取真实房间号）
banned_uid  目标用户 UID
msg         禁言理由（解禁时为空串）
mtype       1 = 直播间禁言
duration    禁言时长（秒），0 = 解除禁言 / 默认时长
csrf        取自 cookie bili_jct，每次请求前动态读取
```

`csrf` 动态读取的原因：页面长时间停留后 token 可能更新，缓存会导致请求被拒。所有请求均带 `credentials: "include"`，复用页面登录态。

### 时序

```
t0 ── 发送禁言请求 ──► t1 收到 code:0
                          │
                          ├─ 等待 unbanDelayMs（默认 300ms，上限 500ms）
                          ▼
t2 ── 发送解禁请求 ──► t3 收到 code:0
                          │
                          └─ 等待 cycleIntervalMs → 进入下一轮
```

**500ms 硬约束的两道保障：**

1. **配置层**：`clampUnbanDelay()` 在 `start()` 与 `saveConfig` 两处夹紧，配置无法绕过上限。
2. **运行时层**：`sleepUntil(deadline)` 按**绝对时间点**自校正（提前醒来即补睡），而非简单 `setTimeout` 累加；同时预扣 `UNBAN_SAFETY_MS = 45ms` 抖动余量。

第 2 点来自实测结论：浏览器定时器存在 1–16ms 抖动，叠加一次事件循环 tick 与 fetch 派发开销，合计可达 40ms 以上。若直接 `setTimeout(500)`，端到端实测间隔会落在 503–530ms 而越过约束。当前实现下，配置 `300ms` 时实测约 300ms，配置上限 `500ms` 时实测约 480ms。

面板上的 **解禁间隔** 显示的是真实测量的 `unbanGapMs`，可用于直接核验约束是否满足。

### 为什么循环跑在页面主世界

MV3 的 service worker 会被浏览器随时回收，若把循环挂在 SW 上，运行连续性无法保证。因此循环引擎被注入直播间页面的**主世界**：

- SW 生命周期与 popup 开关均不影响循环；
- 请求携带页面自身的登录态与 cookie，与手动操作一致；
- service worker 退化为纯配置存储与消息中转角色。

### 消息协议

页面主世界通过 `postMessage`（channel `BML_LOOP`）上报事件，内容脚本与 service worker 双向转发：

```
页面 → 扩展：ready / status / round / log / stopped / ack
扩展 → 页面：start / stop / pause / resume / update / ping / probe
```

## ✅ 测试验证

扩展的核心逻辑可在纯 Node 环境下仿真验证，无需浏览器。两套测试用 `vm` 模块 mock `window / document / cookie / fetch`，**直接运行真实的 `src/runtime.js`**，而不是复制的测试替身：

```bash
git clone https://github.com/Hu-Yang-rui/bili-mute-loop.git && cd bili-mute-loop
node test/harness.js         # 循环时序与请求体
node test/harness-pause.js   # 暂停 / 继续语义
node test/dump-requests.js   # 打印实际请求体，核对禁言理由字段
```

两套测试共 **36 项断言**（`harness.js` 19 项 + `harness-pause.js` 17 项）。

`dump-requests.js` 输出示例（可直接看到「禁言理由」只出现在禁言请求里，解禁时必为空串）：

```
[1] POST /xroom/v1/Room/room_silence   ← 禁言
    请求体: {"room_id":"21452505","banned_uid":"10086","msg":"循环联调测试","mtype":"1","duration":"0","csrf":"..."}
[2] POST /xroom/v1/Room/room_silence   ← 解禁
    请求体: {"room_id":"21452505","banned_uid":"10086","msg":"","mtype":"1","duration":"0","csrf":"..."}
```

CI 在每次 push 与 PR 时自动执行语法检查、清单 JSON 校验与两套测试（见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。

### 覆盖点

| 测试 | 断言 |
| --- | --- |
| `harness.js` | 每轮顺序恒为 `禁言 → 解禁`；实测间隔 ≤ 500ms；`-509` 限频指数退避后成功；`unbanDelayMs=999` 被夹紧；请求体字段正确（`csrf` / `banned_uid` / `room_id` / 解禁时 `msg=""` 且 `duration=0`） |
| `harness-pause.js` | 暂停最多让在途 1 轮跑完，之后计数冻结；暂停期间 `running=true`；`resume` 后计数继续累加；暂停中 `stop()` 正常退出且不多跑轮次；`postMessage` 协议 `pause`/`resume` 正确回 ack |

### 最近一次运行输出

```
[PASS] 每轮 禁言→解禁 间隔 ≤ 500ms  → 466, 468, 465 ms
[PASS] 每对 禁言→解禁 间隔 ≤ 500ms  → 484, 484, 481 ms
[PASS] 解禁请求 msg 为空且 duration=0（不会被误判为再次禁言）
全部通过 ✅

[PASS] 挂起后 900ms 内没有开始新一轮  → 4 → 4
[PASS] 暂停状态下 stop() 能正常退出（<3s）  → 耗时 65ms，running=false
暂停/继续 全部通过 ✅
```

### 仿真测试发现并修复的两个缺陷

仿真环境让以下两个缺陷得以复现，它们已修复并纳入回归断言：

1. **`msg` 默认值覆盖导致解禁被误判为再次禁言** — 原实现写作 `msg: msg || CFG.msg`，解禁传入的空串被默认理由填充，接口会把请求当成一次新的禁言。改为 `msg === undefined ? CFG.msg : msg`。
2. **定时抖动导致解禁间隔越过 500ms** — 原实现用 `sleep(unbanDelayMs)`，实测间隔 503–530ms。改为绝对时间点自校正并预扣抖动余量。

## 🛡 稳定性设计

| 机制 | 说明 |
| --- | --- |
| 主世界执行 | 循环不依赖 service worker 生命周期，SW 回收与面板开关均不中断 |
| 指数退避 | `-412` / `-509` / 网络异常按 `retryDelayMs × 2ⁿ` 重试，默认 3 次 |
| 风控节流 | 命中 `-412` / `-509` / `-101` 时额外退避 1500ms 再进入下一轮 |
| 重复注入防护 | `window.__BML_LOOP_INSTALLED__` 与 script 标签 id 双重判重 |
| 前置校验 | 请求前校验 `bili_jct` 与房间号，避免无意义的接口调用 |
| 状态上报 | popup 重新打开后可恢复显示运行中状态 |
| 热更新 | 循环运行中修改面板配置即时生效，无需重启循环 |

## ❓ 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `内容脚本未就绪，请刷新直播间页面后重试` | 扩展新装或重载后页面未刷新；刷新直播间页面即可 |
| `未取到 bili_jct（请先在该浏览器登录 B 站）` | 未登录或 cookie 被清理；重新登录 |
| `code=-101` 未登录 / `code=-403` 无权限 | 当前账号在该房间没有房管权限 |
| `code=-412` 请求被拦截 | 触发风控；降低频率（加大周期间隔或延迟）后重试 |
| `code=-509` 请求过于频繁 | 同上 |
| 解禁返回业务错误 | 部分房间对「禁言后立即解禁」存在后端保护窗口；扩展会按退避重试，也可适当加大 `unbanDelayMs`（≤ 500ms）缓解 |
| 探测按钮无返回 | 需先打开直播间标签页 |

## 📊 调参基线

| 场景 | unbanDelayMs | cycleIntervalMs | maxRounds |
| --- | --- | --- | --- |
| 功能验证 | 300 | 800 | 5 |
| 稳定性观察 | 400 | 1500 | 50 |
| 长稳压测 | 500 | 3000 | 0 |

调用频率越高越容易触发 `-412`。合理路径是从「功能验证」档起步，确认接口与权限链路正常后再逐步放大。

## ⚖️ 边界说明

**本扩展不做的事**：绕过任何权限校验、批量或自动识别目标用户、对无房管权限的房间发起操作、对抗风控或封禁机制。

**使用前提**：仅在账号确实具备房管权限的直播间内使用，并遵守 B 站用户协议与直播间管理规定。

**免责声明**：本软件以 MIT 许可证按"原样"提供，不附带任何明示或暗示的担保。使用者需自行确保其使用行为符合平台规则及所在地法律法规，因使用本软件产生的一切后果由使用者自行承担。详见 [LICENSE](LICENSE)。

## 📁 项目结构

```
bili-mute-loop/
├─ manifest.json            MV3 清单：权限 / 内容脚本 / 可访问资源
├─ src/
│  ├─ runtime.js            主世界执行体：禁言/解禁循环引擎、时序控制、重试
│  ├─ page-bridge.js        内容脚本：注入 runtime、消息桥接、自动启动
│  ├─ background.js         service worker：配置持久化、指令转发
│  └─ popup.html/.css/.js   控制面板 UI
├─ test/
│  ├─ harness.js            循环时序与请求体仿真测试
│  └─ harness-pause.js      暂停 / 继续语义测试
├─ .github/workflows/ci.yml CI：语法检查 + 清单校验 + 两套测试
├─ LICENSE
└─ README.md
```

## 🤝 开发与贡献

```bash
node test/harness.js         # 循环时序
node test/harness-pause.js   # 暂停 / 继续
```

修改 `src/` 后需在 `chrome://extensions/` 点击该扩展的刷新按钮，并刷新直播间页面方可生效。

欢迎提交 Issue 与 PR，尤其欢迎以下方向的实测数据：不同房间的接口返回差异、风控阈值与限频边界、其他平台的同类时序场景。

## 📄 许可证

[MIT License](LICENSE) © 2025 [Hu-Yang-rui](https://github.com/Hu-Yang-rui)

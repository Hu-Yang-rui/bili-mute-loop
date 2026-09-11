/**
 * tools/release-notes.js — 用 UTF-8 安全的方式写入 GitHub Release 正文。
 *
 * 为什么需要它：PowerShell 5.1 在向 Invoke-RestMethod 传中文 body 时按 ANSI 编码，
 * 会把正文变成 "????"。Node 的 fetch 原生 UTF-8，能避免这个问题。
 *
 * 用法：
 *   set GITHUB_TOKEN=xxx
 *   node tools/release-notes.js            # 更新 v1.0.0 的正文
 *   node tools/release-notes.js v1.0.1     # 指定 tag
 */

const OWNER = "Hu-Yang-rui";
const REPO = "bili-mute-loop";
const tag = process.argv[2] || "v1.0.0";
const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("缺少 GITHUB_TOKEN 环境变量");
  process.exit(1);
}

const notes = `## 安装

1. 下载下方 **Assets** 中的 \`bili-mute-loop-${tag}.zip\`
2. 解压到任意目录
3. 打开 \`chrome://extensions/\`，开启右上角 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压出的目录
5. 刷新已打开的 B 站直播间页面

要求 Chrome ≥ 111（依赖 MV3 的主世界注入能力）。

## 功能

- 按 UID 指定目标用户，循环执行「禁言 → 解除禁言」
- 禁言完成到发起解禁的间隔硬约束 **≤ 500ms**，实测稳定在 480ms 以内
- 支持暂停 / 继续：在一轮边界挂起，不遗留「已禁言未解禁」状态
- \`-412\` 风控 / \`-509\` 限频按指数退避自动重试
- 控制面板实时显示轮次、成功、失败、实测解禁间隔与滚动日志
- 循环运行在页面主世界，service worker 回收与面板开关均不中断

## 接口

| 动作 | 方法与路径 |
| --- | --- |
| 禁言 / 解禁 | \`POST /xroom/v1/Room/room_silence\` |
| 状态查询 | \`GET /xlive/web-ucenter/v1/banned/QueryBlackListUser\` |

## 测试

两套 Node 仿真测试共 **36 项断言**，CI 全绿：

\`\`\`bash
node test/harness.js         # 循环时序与请求体（19 项）
node test/harness-pause.js   # 暂停 / 继续语义（17 项）
\`\`\`

## 说明

本扩展不绕过任何权限校验，仅复用浏览器已登录的直播间会话；能否执行取决于账号在该房间是否具备房管权限。
请在具备房管权限的直播间内使用，并遵守平台规则。

## 许可证

MIT
`;

(async () => {
  const api = `https://api.github.com/repos/${OWNER}/${REPO}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "bili-mute-loop-release",
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json; charset=utf-8"
  };

  const res = await fetch(`${api}/releases/tags/${tag}`, { headers });
  if (!res.ok) {
    console.error(`未找到 tag ${tag} 的 Release：HTTP ${res.status}`);
    process.exit(1);
  }
  const rel = await res.json();

  const patch = await fetch(`${api}/releases/${rel.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: `${tag} · 首个公开版本`, body: notes })
  });
  if (!patch.ok) {
    console.error(`更新失败：HTTP ${patch.status} ${await patch.text()}`);
    process.exit(1);
  }
  const updated = await patch.json();

  console.log(`已更新 Release ${updated.tag_name}`);
  console.log(`  标题  : ${updated.name}`);
  console.log(`  正文  : ${updated.body.length} 字符`);
  console.log(`  链接  : ${updated.html_url}`);
  console.log(`  正文首行: ${updated.body.split("\n")[0]}`);
})();

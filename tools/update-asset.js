/**
 * tools/update-asset.js — 把 dist/ 里的压缩包替换到 GitHub Release 资产上。
 *
 * 为什么需要它：GitHub 不允许覆盖同名资产，必须「删除旧的 + 上传新的」两步。
 * PowerShell 处理二进制 body 与中文都很别扭，这里用 Node 的 fetch + Buffer。
 *
 * 用法：
 *   set GITHUB_TOKEN=xxx
 *   node tools/update-asset.js            # 更新 v1.0.0
 *   node tools/update-asset.js v1.0.1
 */

const fs = require("fs");
const path = require("path");

const OWNER = "Hu-Yang-rui";
const REPO = "bili-mute-loop";
const tag = process.argv[2] || "v1.0.0";
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("缺少 GITHUB_TOKEN 环境变量");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
const zipPath = path.join(__dirname, "..", "dist", `bili-mute-loop-${tag}.zip`);
if (!fs.existsSync(zipPath)) {
  console.error(`找不到压缩包：${zipPath}\n先执行 node tools/pack.js ${tag}`);
  process.exit(1);
}

const api = `https://api.github.com/repos/${OWNER}/${REPO}`;
const baseHeaders = {
  Authorization: `Bearer ${token}`,
  "User-Agent": "bili-mute-loop-release",
  Accept: "application/vnd.github+json"
};

(async () => {
  const relRes = await fetch(`${api}/releases/tags/${tag}`, { headers: baseHeaders });
  if (!relRes.ok) {
    console.error(`未找到 Release ${tag}：HTTP ${relRes.status}`);
    process.exit(1);
  }
  const rel = await relRes.json();
  const assetName = `bili-mute-loop-${tag}.zip`;

  // 1) 删除同名旧资产
  for (const a of rel.assets) {
    if (a.name !== assetName) continue;
    const del = await fetch(`${api}/releases/assets/${a.id}`, { method: "DELETE", headers: baseHeaders });
    console.log(`已删除旧资产 ${a.name}（id=${a.id}）→ HTTP ${del.status}`);
  }

  // 2) 上传新资产
  const buf = fs.readFileSync(zipPath);
  const upRes = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`,
    { method: "POST", headers: Object.assign({}, baseHeaders, { "Content-Type": "application/zip" }), body: buf }
  );
  if (!upRes.ok) {
    console.error(`上传失败：HTTP ${upRes.status} ${await upRes.text()}`);
    process.exit(1);
  }
  const asset = await upRes.json();

  console.log(`已上传 ${asset.name}`);
  console.log(`  大小   : ${asset.size} 字节（本地 ${buf.length} 字节）`);
  console.log(`  清单版本: manifest.json v${manifest.version}`);
  console.log(`  下载   : ${asset.browser_download_url}`);
  console.log(`  直链   : ${rel.assets[0] ? "" : ""}https://github.com/${OWNER}/${REPO}/releases/latest/download/${assetName}`);
  process.exit(asset.size === buf.length ? 0 : 1);
})();

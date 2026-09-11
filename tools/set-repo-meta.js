/**
 * tools/set-repo-meta.js — 修正 GitHub 仓库的元信息（描述 / 主页 / topics）。
 *
 * 为什么需要它：PowerShell 5.1 把中文 body 按 ANSI 编码发给 GitHub API，
 * 结果仓库描述里的中文全部变成 "?"。Node 的 fetch 原生 UTF-8，可以避免。
 * 注意：仓库描述必须与 package.json 的 description 保持一致。
 *
 * 用法：
 *   set GITHUB_TOKEN=xxx
 *   node tools/set-repo-meta.js
 */

const fs = require("fs");
const path = require("path");

const OWNER = "Hu-Yang-rui";
const REPO = "bili-mute-loop";
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("缺少 GITHUB_TOKEN 环境变量");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

const meta = {
  description: pkg.description,                        // 与 package.json 单一来源
  homepage: `https://github.com/${OWNER}/${REPO}`,
  has_issues: true,
  has_wiki: false,
  has_projects: false,
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: true,
  delete_branch_on_merge: true
};

const topics = {
  names: [
    "chrome-extension",
    "manifest-v3",
    "bilibili",
    "live-stream",
    "automation",
    "javascript",
    "browser-extension",
    "moderation-tools"
  ]
};

const headers = {
  Authorization: `Bearer ${token}`,
  "User-Agent": "bili-mute-loop-meta",
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json; charset=utf-8"
};

(async () => {
  const api = `https://api.github.com/repos/${OWNER}/${REPO}`;

  const patch = await fetch(api, { method: "PATCH", headers, body: JSON.stringify(meta) });
  if (!patch.ok) {
    console.error(`PATCH 失败：HTTP ${patch.status} ${await patch.text()}`);
    process.exit(1);
  }
  const updated = await patch.json();
  console.log("仓库描述已更新");
  console.log(`  description : ${updated.description}`);
  console.log(`  homepage    : ${updated.homepage}`);

  const t = await fetch(`${api}/topics`, { method: "PUT", headers, body: JSON.stringify(topics) });
  console.log(`  topics      : HTTP ${t.status}`);

  // 复核：重新读取，确认没有问号残留
  const check = await (await fetch(api, { headers })).json();
  const bad = /[?]{2,}/.test(check.description || "");
  console.log("");
  console.log(`一致性校验（与 package.json 相同）: ${check.description === pkg.description ? "通过 ✅" : "不一致 ❌"}`);
  console.log(`问号乱码残留: ${bad ? "仍存在 ❌" : "无 ✅"}`);
  console.log(`manifest 名称: ${manifest.name}（本地为准，GitHub 上没有该字段）`);
  process.exit(check.description === pkg.description && !bad ? 0 : 1);
})();

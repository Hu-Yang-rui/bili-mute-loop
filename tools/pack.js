/**
 * tools/pack.js — 生成可上传到 GitHub Release 的扩展压缩包。
 *
 * 为什么不用 PowerShell 的 Compress-Archive：
 * 它把条目名写成反斜杠（src\runtime.js），不符合 ZIP 规范（应为正斜杠），
 * 在 Linux / macOS / 网页端解压时可能得到名为 "src\runtime.js" 的单文件。
 * 这里用 zlib 直接写标准 ZIP（deflateRaw + CRC32 + 正斜杠条目名）。
 *
 * 用法： node tools/pack.js [版本号]
 * 产物： dist/bili-mute-loop-v<版本>.zip
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
const OUT_DIR = path.join(ROOT, "dist");
const OUT = path.join(OUT_DIR, `bili-mute-loop-v${version}.zip`);

/** 打进包里的文件（相对扩展根目录；顺序即包内顺序） */
const FILES = [
  "manifest.json",
  "src/runtime.js",
  "src/page-bridge.js",
  "src/background.js",
  "src/popup.html",
  "src/popup.css",
  "src/popup.js",
  "LICENSE",
  "README.md"
];

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- DOS 时间戳 ---------------- */
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/* ---------------- 写入 ZIP ---------------- */
const now = new Date();
const { time: dosTime, date: dosDate } = dosDateTime(now);

const chunks = [];
const central = [];
let offset = 0;
let rawTotal = 0;
let zipTotal = 0;

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  const data = fs.readFileSync(abs);
  const name = Buffer.from(rel.split(path.sep).join("/"), "utf8"); // 关键：正斜杠
  const crc = crc32(data);
  const deflated = zlib.deflateRawSync(data, { level: 9 });

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
  local.writeUInt16LE(20, 4);           // 解压所需版本 2.0
  local.writeUInt16LE(0x0800, 6);       // 通用标志：文件名 UTF-8
  local.writeUInt16LE(8, 8);            // 压缩方法 deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);           // 无扩展字段

  chunks.push(local, name, deflated);
  central.push({ name, crc, comp: deflated.length, size: data.length, offset });
  offset += local.length + name.length + deflated.length;
  rawTotal += data.length;
  zipTotal += local.length + name.length + deflated.length;
}

const centralStart = offset;
for (const e of central) {
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);      // 中央目录签名
  cd.writeUInt16LE(20, 4);              // 创建版本
  cd.writeUInt16LE(20, 6);              // 解压所需版本
  cd.writeUInt16LE(0x0800, 8);          // UTF-8 标志
  cd.writeUInt16LE(8, 10);              // deflate
  cd.writeUInt16LE(dosTime, 12);
  cd.writeUInt16LE(dosDate, 14);
  cd.writeUInt32LE(e.crc, 16);
  cd.writeUInt32LE(e.comp, 20);
  cd.writeUInt32LE(e.size, 24);
  cd.writeUInt16LE(e.name.length, 28);
  cd.writeUInt16LE(0, 30);              // 扩展字段长度
  cd.writeUInt16LE(0, 32);              // 注释长度
  cd.writeUInt16LE(0, 34);              // 磁盘号
  cd.writeUInt16LE(0, 36);              // 内部属性
  cd.writeUInt32LE(0x81a40000 >>> 0, 38); // 外部属性：0644
  cd.writeUInt32LE(e.offset, 42);
  chunks.push(cd, e.name);
  zipTotal += cd.length + e.name.length;
}

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);      // 中央目录结束签名
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(central.length, 8);
eocd.writeUInt16LE(central.length, 10);
eocd.writeUInt32LE(zipTotal, 12);
eocd.writeUInt32LE(centralStart, 16);
eocd.writeUInt16LE(0, 20);
chunks.push(eocd);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, Buffer.concat(chunks));

console.log(`已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  文件数      : ${FILES.length}`);
console.log(`  原始大小    : ${(rawTotal / 1024).toFixed(1)} KB`);
console.log(`  压缩后      : ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`  条目名分隔符: /（符合 ZIP 规范）`);

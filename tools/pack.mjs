#!/usr/bin/env node
// 打包：把项目压成一个可分发的 zip，落在 dist/。
//
// 打包策略（与 0.1.0 那版手工 zip 保持一致）：
//   - 进包：bin/ src/ mcp/ skills/ assets/ tools/（probe-* 除外） .codex-plugin/ .mcp.json package.json README.md docs/ROUTE-INDEX.md
//   - 不进包：dist/ 自己、docs/ 下的截图、tools/probe-*（真机探针，依赖本机 Codex）、.DS_Store、任何 _cwe-backup-*
//
// 用法：
//   node tools/pack.mjs               # 版本号取自 package.json，日期取今天
//   node tools/pack.mjs --dry         # 只打印清单，不落盘

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const ALWAYS = [
  "bin",
  "src",
  "mcp",
  "skills",
  "assets",
  "tools",
  ".codex-plugin",
  ".mcp.json",
  "package.json",
  "README.md",
];
const SINGLE_FILES = ["docs/ROUTE-INDEX.md", "docs/DOM-MAP.md"];

const SKIP_DIR = new Set(["dist", "node_modules", ".git"]);
const SKIP_FILE = [/^\.DS_Store$/, /^_cwe-backup-/, /^probe-.*\.(mjs|js)$/];

function walk(abs, rel, out) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    if (SKIP_DIR.has(path.basename(rel))) return;
    for (const name of fs.readdirSync(abs).sort()) {
      if (name.startsWith("_cwe-backup-")) continue;
      walk(path.join(abs, name), path.join(rel, name), out);
    }
    return;
  }
  if (SKIP_FILE.some((re) => re.test(path.basename(rel)))) return;
  if (rel.startsWith("docs" + path.sep) && rel.endsWith(".png")) return;
  out.push(rel);
}

const files = [];
for (const entry of ALWAYS) {
  const abs = path.join(ROOT, entry);
  if (!fs.existsSync(abs)) continue;
  walk(abs, entry, files);
}
for (const entry of SINGLE_FILES) {
  if (fs.existsSync(path.join(ROOT, entry))) files.push(entry);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const name = `${pkg.name}-${pkg.version}-${stamp}.zip`;
const outPath = path.join(ROOT, "dist", name);

const dry = process.argv.includes("--dry");
console.log(`[${files.length} files] -> dist/${name}`);
if (dry) {
  for (const f of files) console.log("  " + f);
  process.exit(0);
}

fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
if (fs.existsSync(outPath)) fs.rmSync(outPath);
execFileSync("/usr/bin/zip", ["-q", "-r", "-X", outPath, ...files], { cwd: ROOT, stdio: "inherit" });

const size = fs.statSync(outPath).size;
console.log(`done: ${outPath}  (${(size / 1024).toFixed(1)} KiB)`);

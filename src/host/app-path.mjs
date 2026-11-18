/**
 * src/host/app-path.mjs —— 找到 Codex / ChatGPT 桌面的可执行文件
 *
 * 原来 bin/cwe.mjs 和 bin/cwe-watch.mjs 各自写死
 *   /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
 * 一是路径只有一种（换名字、装在 ~/Applications、用 Codex.app 都找不到），
 * 二是 macOS 之外必然失败。这里做成「候选列表 + 平台分支 + 环境变量覆盖」。
 *
 * 找不到就返回 null，由调用方决定是报错还是跳过 —— 本模块不抛。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 应用包里可执行文件的相对路径。 */
function binIn(bundle, name) {
  return join(bundle, "Contents", "MacOS", name);
}

function appBundle(bin) {
  return bin.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1] || null;
}

/**
 * macOS 上的候选。顺序 = 命中概率，命名变体都放进来：
 * Codex 桌面几次改名，二进制名和包名不一定一致，逐个试比猜一个稳。
 */
function macCandidates() {
  const roots = ["/Applications", join(homedir(), "Applications")];
  const bundles = [
    ["ChatGPT.app", "ChatGPT"],
    ["Codex.app", "Codex"],
    ["ChatGPT Desktop.app", "ChatGPT Desktop"],
  ];
  const out = [];
  for (const r of roots) {
    for (const [bundle, bin] of bundles) {
      out.push(binIn(join(r, bundle), bin));
      // 少数发行版二进制名带空格 / 带 helper 后缀
      out.push(binIn(join(r, bundle), bundle.replace(/\.app$/, "")));
    }
  }
  return out;
}

/** Windows 上的候选：%LOCALAPPDATA% 下的 ChatGPT / Codex。 */
function winCandidates() {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const out = [];
  for (const name of ["ChatGPT", "Codex"]) {
    out.push(join(local, "Programs", name, name + ".exe"));
    out.push(join(local, name, name + ".exe"));
  }
  out.push(join("C:\\Program Files", "ChatGPT", "ChatGPT.exe"));
  return out;
}

/** Linux 上的候选：AppImage / 系统包 / 用户目录。 */
function linuxCandidates() {
  return ["/opt/ChatGPT/chatgpt", "/opt/Codex/codex", "/usr/bin/chatgpt", "/usr/bin/codex", "/usr/local/bin/chatgpt"];
}

/**
 * 返回 { bin, bundle, platform, source } 或 null。
 * 环境变量 CWE_APP_BIN 优先 —— 装在非常规位置时不用改代码。
 */
export function findAppBinary() {
  const forced = process.env.CWE_APP_BIN;
  if (forced && existsSync(forced)) {
    return { bin: forced, bundle: appBundle(forced), platform: process.platform, source: "env" };
  }
  const platform = process.platform;
  let cands = [];
  if (platform === "darwin") cands = macCandidates();
  else if (platform === "win32") cands = winCandidates();
  else cands = linuxCandidates();

  for (const bin of cands) {
    if (existsSync(bin)) {
      // 从 .../X.app/Contents/MacOS/X 反推出 X.app
      return { bin, bundle: appBundle(bin), platform, source: "scan" };
    }
  }
  return null;
}

/** 给人看的「我找过哪些地方」。找不到时打出来，比只说一句「找不到」有用。 */
export function describeSearch() {
  const platform = process.platform;
  const list = platform === "darwin" ? macCandidates() : platform === "win32" ? winCandidates() : linuxCandidates();
  return list;
}

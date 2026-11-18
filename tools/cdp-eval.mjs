#!/usr/bin/env node
// 极简 CDP 求值工具：node tools/cdp-eval.mjs <port> <target|main> <scriptFile>
// 'main' 精确匹配 app://-/index.html；其余按 url 子串匹配。结果以 JSON 打印，命中 target 打到 stderr。
import { readFileSync } from "node:fs";
import { Cdp, probePort, listPages } from "../src/host/cdp.mjs";

const [portArg, match = "main", file] = process.argv.slice(2);
const port = Number(portArg || 9333);
if (!file) {
  console.error("用法: node tools/cdp-eval.mjs <port> <main|urlSubstring> <scriptFile>");
  process.exit(2);
}
const src = readFileSync(file, "utf8");
const info = await probePort(port);
if (!info || !info.ok) {
  console.error("CDP 不可达: " + port);
  process.exit(1);
}
const pages = await listPages(port);
const target =
  match === "main"
    ? pages.find((p) => p.url === "app://-/index.html")
    : pages.find((p) => p.url.includes(match));
if (!target) {
  console.error("没有匹配的 page target；当前: " + pages.map((p) => p.url).join(" | "));
  process.exit(1);
}
console.error("target: " + target.url);
const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
try {
  const out = await cdp.eval(src, { awaitPromise: true, returnByValue: true, timeoutMs: 20000 });
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error("eval 失败: " + (e && e.message));
  process.exitCode = 1;
} finally {
  cdp.close();
}

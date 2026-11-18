#!/usr/bin/env node
// 截图：node tools/shot.mjs <port> <out.png>
import { writeFileSync } from "node:fs";
import { Cdp, probePort, listPages } from "../src/host/cdp.mjs";
const [portArg = "9333", out = "docs/shot.png"] = process.argv.slice(2);
const pages = await listPages(Number(portArg));
const t = pages.find((p) => p.url === "app://-/index.html");
if (!t) { console.error("无主窗口 target"); process.exit(1); }
const cdp = await Cdp.attach(t.webSocketDebuggerUrl);
try {
  await cdp.send("Page.enable");
  await new Promise((r) => setTimeout(r, 500));
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log("saved " + out);
} finally { cdp.close(); }

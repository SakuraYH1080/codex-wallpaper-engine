import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] || 9333);
const tabName = process.argv[3] || "头像";
const outPath = process.argv[4];
const info = await probePort(port);
if (!info.ok) { console.error("no cdp"); process.exit(1); }
const { cdp } = await connectMain(port, { timeoutMs: 10000 });
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const expr = `(() => {
  const CWE = window.__CWE;
  if (!CWE || !CWE.panel) return "no panel";
  CWE.panel.show();
  const host = document.getElementById("cwe-panel-host");
  const sr = host && host.shadowRoot;
  if (!sr) return "no shadow";
  const b = [...sr.querySelectorAll(".tab")].find(x => x.textContent.trim() === ${JSON.stringify(tabName)});
  if (!b) return "no tab";
  b.click();
  return "ok";
})()`;
console.log("click:", await cdp.eval(expr, { awaitPromise: false, timeoutMs: 8000 }));
await sleep(900);
const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 20000);
writeFileSync(outPath, Buffer.from(shot.data, "base64"));
console.log("shot:", outPath);
cdp.close();

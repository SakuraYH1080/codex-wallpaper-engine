import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const port = Number(process.argv[2] || 9333);
const out = process.argv[3] || "docs/crop-launcher.png";
const rectExpr = readFileSync("/tmp/cwe-crop-rect.js", "utf8");

const { cdp } = await connectMain(port, { match: "app://-/index.html", timeoutMs: 10000 });
await cdp.send("Page.enable", {});
const rect = await cdp.eval(rectExpr, { awaitPromise: true, returnByValue: true });
await sleep(500);
const res = await cdp.send("Page.captureScreenshot", {
  format: "png",
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 3 },
});
writeFileSync(out, Buffer.from(res.data, "base64"));
console.log("rect", JSON.stringify(rect), "->", out);
cdp.close();

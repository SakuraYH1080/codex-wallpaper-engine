import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectMain, sleep } from "../src/host/cdp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { cdp, target } = await connectMain(9333);
await cdp.send("Runtime.enable");
const info = await cdp.eval(`(() => ({
  url: location.href,
  title: document.title,
  rootChildren: document.getElementById("root")?.childElementCount ?? -1,
  hasComposer: !!document.querySelector('[contenteditable="true"]'),
  bodyLen: document.body.innerHTML.length,
  text: (document.body.innerText || "").slice(0, 160)
}))()`);
console.log(JSON.stringify(info, null, 2));
await cdp.send("Page.enable");
const r = await cdp.send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync(resolve(ROOT, "docs/after-reload.png"), Buffer.from(r.data, "base64"));
console.log("shot saved");
cdp.close();
process.exit(0);

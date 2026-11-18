import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";
import { writeFileSync } from "node:fs";
const port = 9333;
const { cdp } = await connectMain(port, { timeoutMs: 10000 });
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
// 先强制重渲染一次，等图片真正下载完成
const ev = `(async () => {
  const CWE = window.__CWE;
  CWE.panel.show();
  const host = document.getElementById("cwe-panel-host");
  const sr = host.shadowRoot;
  const b = [...sr.querySelectorAll(".tab")].find(x => x.textContent.trim() === "头像");
  b.click();
  await new Promise(r => setTimeout(r, 200));
  const pv = sr.querySelector(".face .pv");
  const url = pv.style.backgroundImage.slice(5, -2);
  const ok = await new Promise(res => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.onerror = () => res(null); i.src = url; });
  const r = pv.getBoundingClientRect();
  return { url, loaded: ok, rect: [r.x, r.y, r.width, r.height] };
})()`;
const info = await cdp.eval(ev, { awaitPromise: true, timeoutMs: 20000 });
console.log(JSON.stringify(info));
await sleep(400);
const r = info.rect;
const shot = await cdp.send("Page.captureScreenshot", {
  format: "png",
  clip: { x: r[0] - 6, y: r[1] - 6, width: r[2] + 12, height: r[3] + 12, scale: 2 },
}, 20000);
writeFileSync("docs/crop-face.png", Buffer.from(shot.data, "base64"));
console.log("saved docs/crop-face.png");
cdp.close();

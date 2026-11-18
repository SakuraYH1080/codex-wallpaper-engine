import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] || 9333);
const out = process.argv[3] || "docs/fx-1.png";
await probePort(port);
const { cdp } = await connectMain(port, { timeoutMs: 15000 });
await cdp.send("Page.enable", {});

// 派发一串指针移动 + 一次点击：FX 层监听的是 window 级 pointermove/pointerdown，
// 合成事件必须带 bubbles 才会被它收到。
const drive = `(() => {
  const w = window.__CWE;
  if (!w || !w.state || !w.state.fx || !w.state.fx.enabled) return { ok: false, reason: "fx off", fx: w && w.state && w.state.fx };
  for (let i = 0; i < 24; i++) {
    const x = 300 + i * 34, y = 260 + Math.sin(i / 3) * 120;
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
  }
  window.dispatchEvent(new PointerEvent("pointerdown", { clientX: 700, clientY: 420, bubbles: true, button: 0 }));
  return { ok: true, fx: w.state.fx, parallax: w.state.parallax };
})()`;
const r = await cdp.eval(drive, { awaitPromise: false, returnByValue: true });
console.log("drive:", JSON.stringify(r.result && r.result.value || r));
await sleep(90);
const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("saved", out);
cdp.close();
process.exit(0);

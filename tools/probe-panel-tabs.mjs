import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";

const port = Number(process.argv[2] || 9333);
const info = await probePort(port);
if (!info.ok) { console.error("no cdp on", port); process.exit(1); }
const { cdp } = await connectMain(port, { timeoutMs: 10000 });
await cdp.send("Runtime.enable");

const RD = `(() => {
  const CWE = window.__CWE;
  const host = document.getElementById("cwe-panel-host");
  const sr = host && host.shadowRoot;
  if (!sr) return { err: "no shadow" };
  const body = sr.querySelector(".body");
  return {
    tabs: [...sr.querySelectorAll(".tab")].map(b => b.textContent.trim()),
    active: (sr.querySelector(".tab[data-on='1']") || {}).textContent,
    len: body ? body.innerHTML.length : 0,
    text: body ? body.textContent.replace(/\\s+/g, " ").slice(0, 200) : "",
    chips: sr.querySelectorAll(".chip").length,
    faces: sr.querySelectorAll(".face").length,
    tiles: sr.querySelectorAll(".tile").length,
    rows: sr.querySelectorAll(".row").length,
  };
})()`;

const out = { startedAt: new Date().toISOString(), steps: [] };
let r = await cdp.eval(RD, { awaitPromise: false, timeoutMs: 10000 });
out.steps.push({ step: "initial", ...r });
console.log(JSON.stringify(out.steps[0]));

const names = r.tabs || [];
for (let i = 0; i < names.length; i++) {
  const clickExpr = `(() => {
    const host = document.getElementById("cwe-panel-host");
    const sr = host && host.shadowRoot;
    if (!sr) return "no shadow";
    const b = [...sr.querySelectorAll(".tab")][${i}];
    if (!b) return "no tab " + ${i};
    b.click();
    return b.textContent.trim();
  })()`;
  let clicked;
  try {
    clicked = await cdp.eval(clickExpr, { awaitPromise: false, timeoutMs: 8000 });
  } catch (e) {
    out.steps.push({ step: "click" + i, error: String(e && e.message || e) });
    console.log("CLICK FAIL", i, String(e && e.message || e));
    continue;
  }
  await sleep(450);
  try {
    r = await cdp.eval(RD, { awaitPromise: false, timeoutMs: 8000 });
    out.steps.push({ step: "tab:" + clicked, ...r });
    console.log(JSON.stringify({ tab: clicked, len: r.len, chips: r.chips, faces: r.faces, tiles: r.tiles, rows: r.rows, text: r.text.slice(0, 120) }));
  } catch (e) {
    out.steps.push({ step: "read" + i, error: String(e && e.message || e) });
    console.log("READ FAIL", i, String(e && e.message || e));
  }
}

cdp.close();
console.log("DONE", out.steps.length);

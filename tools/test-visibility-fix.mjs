import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";

const port = 9333;
const pr = await probePort(port);
console.log("probe", pr.ok);
const { cdp, target } = await connectMain(port, { match: "app://-/index.html", timeoutMs: 8000 });
console.log("target", target.url);

const before = await cdp.eval("({v:document.visibilityState, h:document.hidden})", { returnByValue: true });
console.log("BEFORE", JSON.stringify(before));

// 试 Page.setWebLifecycleState —— 把 hidden 页面强行改回 active
try {
  const r = await cdp.send("Page.setWebLifecycleState", { state: "active" });
  console.log("setWebLifecycleState ok", JSON.stringify(r).slice(0, 120));
} catch (e) { console.log("setWebLifecycleState ERR", e.message.slice(0, 160)); }

// 试 focus emulation
try {
  const r = await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  console.log("setFocusEmulationEnabled ok", JSON.stringify(r).slice(0, 120));
} catch (e) { console.log("setFocusEmulationEnabled ERR", e.message.slice(0, 160)); }

await sleep(500);
const after = await cdp.eval("({v:document.visibilityState, h:document.hidden, f:document.hasFocus()})", { returnByValue: true });
console.log("AFTER", JSON.stringify(after));

cdp.close();

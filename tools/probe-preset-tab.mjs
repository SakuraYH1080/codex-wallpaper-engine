import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";

const port = Number(process.argv[2] || 9333);
const tab = process.argv[3] || "预设";

const p = await probePort(port);
if (!p.ok) { console.error("no cdp"); process.exit(1); }
const { cdp } = await connectMain(port, { timeoutMs: 15000 });
await cdp.send("Page.enable", {});
await cdp.send("Runtime.enable", {});

// 确保面板存在并显示
await cdp.eval("window.__CWE && window.__CWE.panel && window.__CWE.panel.show()", { awaitPromise: false });
await sleep(700);

const click = `(function(){
  var h = document.getElementById('cwe-panel-host');
  if (!h || !h.shadowRoot) return 'no-shadow';
  var tabs = [].slice.call(h.shadowRoot.querySelectorAll('.tab'));
  var t = null;
  for (var i=0;i<tabs.length;i++) if (tabs[i].textContent.trim() === ${JSON.stringify(tab)}) { t = tabs[i]; break; }
  if (!t) return 'no-tab:' + tabs.map(function(x){return x.textContent.trim();}).join(',');
  t.click();
  return 'clicked';
})()`;
const cr = await cdp.eval(click, { awaitPromise: false, timeoutMs: 8000 });
console.log("click:", JSON.stringify(cr.result?.value ?? cr));
await sleep(600);

const read = `(function(){
  var h = document.getElementById('cwe-panel-host');
  if (!h || !h.shadowRoot) return {err:'no-shadow'};
  var sr = h.shadowRoot;
  var tabs = [].slice.call(sr.querySelectorAll('.tab')).map(function(x){return x.textContent.trim();});
  var body = sr.querySelector('.body');
  var chips = [].slice.call(sr.querySelectorAll('[data-preset]')).map(function(x){return x.textContent.trim();});
  var rows = [].slice.call(sr.querySelectorAll('.row')).length;
  var btns = [].slice.call(sr.querySelectorAll('.btn')).map(function(x){return x.textContent.trim();});
  return {
    ver: (window.__CWE.panel||{}).version,
    tabs: tabs,
    bodyLen: body ? body.innerHTML.length : 0,
    presetChips: chips,
    rows: rows,
    btns: btns,
    msg: (sr.querySelector('.ftr')||{}).textContent
  };
})()`;
const rd = await cdp.eval(read, { awaitPromise: true, timeoutMs: 10000 });
console.log(JSON.stringify(rd.result?.value ?? rd, null, 1));
cdp.close();

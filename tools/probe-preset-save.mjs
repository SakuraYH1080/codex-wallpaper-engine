import { probePort, connectMain, sleep } from "../src/host/cdp.mjs";

const port = Number(process.argv[2] || 9333);
const { cdp } = await connectMain(port, { timeoutMs: 15000 });
const p = await probePort(port);
await cdp.send("Page.enable", {});
await cdp.send("Runtime.enable", {});

const READ = `(function(){
  var h = document.getElementById('cwe-panel-host');
  if (!h || !h.shadowRoot) return {err:'no-shadow'};
  var sr = h.shadowRoot;
  return {
    tab: (sr.querySelector('.tab[data-on="1"]')||{}).textContent,
    chips: [].slice.call(sr.querySelectorAll('[data-preset]')).map(function(x){return x.getAttribute('data-preset') + '|' + x.textContent.trim();}),
    rows: [].slice.call(sr.querySelectorAll('.row .k')).map(function(x){return x.textContent.trim();}),
    note: (sr.querySelector('.note')||{}).textContent,
    ftr: (sr.querySelector('.ftr')||{}).textContent
  };
})()`;

async function read() {
  const r = await cdp.eval(READ, { awaitPromise: true, timeoutMs: 8000 });
  return r.result?.value ?? r;
}
async function clickSel(sel) {
  const js = `(function(){var sr=document.getElementById('cwe-panel-host').shadowRoot;var el=sr.querySelector('${sel}');if(!el)return 'missing';el.click();return 'ok';})()`;
  const r = await cdp.eval(js, { awaitPromise: false, timeoutMs: 8000 });
  return r.result?.value ?? r;
}

await cdp.eval("window.__CWE.panel.show()", { awaitPromise: false });
await sleep(500);
// 切到预设 tab
await cdp.eval(`(function(){var sr=document.getElementById('cwe-panel-host').shadowRoot;var ts=[].slice.call(sr.querySelectorAll('.tab'));for(var i=0;i<ts.length;i++)if(ts[i].textContent.trim()==='预设'){ts[i].click();return 1;}return 0;})()`, { awaitPromise: false });
await sleep(500);
console.log("BEFORE", JSON.stringify(await read(), null, 1));

console.log("click save:", await clickSel('[data-act="preset-save"]'));
await sleep(1500);
console.log("AFTER-SAVE", JSON.stringify(await read(), null, 1));

cdp.close();

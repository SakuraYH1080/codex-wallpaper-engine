import { connectMain, sleep } from "../src/host/cdp.mjs";
const { cdp } = await connectMain(9333, { timeoutMs: 15000 });
await cdp.send("Runtime.enable", {});
// cdp.eval 直接返回 result.value
const ev  = (js) => cdp.eval(js, { awaitPromise: false, timeoutMs: 8000 });
const evA = (js) => cdp.eval(js, { awaitPromise: true,  timeoutMs: 10000 });

const READ = `(function(){
  var sr=document.getElementById('cwe-panel-host').shadowRoot;
  return { chips:[].slice.call(sr.querySelectorAll('[data-preset]')).map(function(x){return x.getAttribute('data-preset');}),
           ftr:(sr.querySelector('.ftr')||{}).textContent,
           opacity:(window.__CWE.state||{}).opacity };
})()`;

await ev("window.__CWE.panel.show()");
await sleep(400);
await ev(`(function(){var sr=document.getElementById('cwe-panel-host').shadowRoot;var ts=[].slice.call(sr.querySelectorAll('.tab'));for(var i=0;i<ts.length;i++)if(ts[i].textContent.trim()==='预设'){ts[i].click();return 1;}return 0;})()`);
await sleep(400);
console.log("S0", JSON.stringify(await evA(READ)));

console.log("apply clear-max:", await ev(`(function(){var sr=document.getElementById('cwe-panel-host').shadowRoot;var el=sr.querySelector('[data-preset-apply="clear-max"]');if(!el)return 'missing';el.click();return 'ok';})()`));
await sleep(1800);
console.log("S1", JSON.stringify(await evA(READ)));

var s1 = await evA(READ);
var mine = (s1.chips||[]).filter(function(x){return x.indexOf('p-')===0;});
console.log("mine:", JSON.stringify(mine));
if (mine.length) {
  console.log("del:", await ev(`(function(){var sr=document.getElementById('cwe-panel-host').shadowRoot;var el=sr.querySelector('[data-preset-del="${mine[0]}"]');if(!el)return 'missing';el.click();return 'ok';})()`));
  await sleep(1500);
}
console.log("S2", JSON.stringify(await evA(READ)));
cdp.close();

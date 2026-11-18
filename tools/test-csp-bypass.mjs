import http from "node:http";
import { connectMain, sleep } from "../src/host/cdp.mjs";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
  res.end("HELLO-FROM-LOCALHOST");
});
await new Promise((r) => server.listen(17879, "127.0.0.1", r));

const { cdp, target } = await connectMain(9333);
console.log("target:", target.url);
await cdp.send("Runtime.enable");

const probe = async (label) => {
  try {
    const r = await cdp.eval(
      `fetch("http://127.0.0.1:17879/").then(r=>r.text()).then(t=>"OK:"+t).catch(e=>"ERR:"+e.message)`,
    );
    console.log(label, JSON.stringify(r));
  } catch (e) {
    console.log(label, "THROW:", e.message.slice(0, 200));
  }
};

await probe("1-before-any-bypass");

for (const method of ["Page.setBypassCSP", "Emulation.setBypassCSP"]) {
  try { await cdp.send(method, { enabled: true }); console.log("sent", method); }
  catch (e) { console.log("FAILED", method, String(e.message).slice(0, 160)); }
}
await probe("2-after-bypass-no-reload");

// try reload
try {
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: false });
  console.log("reloaded");
  await sleep(3000);
} catch (e) { console.log("reload failed", e.message); }

// reconnect after reload (target may be same)
await probe("3-after-reload");

server.close();
cdp.close();
process.exit(0);

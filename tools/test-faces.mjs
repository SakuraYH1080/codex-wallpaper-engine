import { createHostServer, PREFIX } from "../src/host/server.mjs";

const tag = (s) => "\n=== " + s + " ===";
const s = createHostServer({ port: 0, log: (lvl, m) => { if (lvl === "error") console.log("ERR", m); } });
const listenOut = await s.listen(0);
const port = s.port;
const base = "http://127.0.0.1:" + port + PREFIX;

async function j(path, opts) {
  const r = await fetch(base + path, opts);
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t.slice(0, 200); }
  return { status: r.status, ct: r.headers.get("content-type"), body };
}

console.log(tag("system-fonts"));
const sf = await j("/system-fonts");
console.log(sf.status, sf.body.fonts.length, sf.body.source, sf.body.approximate, "stale=" + sf.body.stale);

console.log(tag("fontsets list"));
const fl = await j("/fontsets/list");
console.log(fl.status, JSON.stringify(fl.body.fontsets.map(f => f.id + ":" + f.source + ":" + f.name)));

console.log(tag("fontsets get compact"));
const fg = await j("/fontsets/get/compact");
console.log(fg.status, fg.body.source, JSON.stringify(fg.body.doc.values.themeSize));

console.log(tag("fontsets put + get + delete"));
const put = await j("/fontsets/put/big", { method: "POST", body: JSON.stringify({ name: "大字号", values: { themeSize: { "markdown-h1": 28 } } }) });
console.log("put", put.status, JSON.stringify(put.body));
const got2 = await j("/fontsets/get/big");
console.log("get", got2.status, got2.body.source, got2.body.doc.name);
const del = await j("/fontsets/delete/big", { method: "DELETE" });
console.log("delete", del.status, JSON.stringify(del.body));
const delBuiltin = await j("/fontsets/delete/compact", { method: "DELETE" });
console.log("delete builtin (应 409)", delBuiltin.status, JSON.stringify(delBuiltin.body));
const bad = await j("/fontsets/get/..%2F..%2Fetc%2Fpasswd");
console.log("path traversal (应 404)", bad.status, JSON.stringify(bad.body));

console.log(tag("mascot GET 空"));
const m0 = await j("/mascot");
console.log(m0.status, JSON.stringify(m0.body));

console.log(tag("mascot POST 假 png"));
// 1x1 png
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const m1 = await j("/mascot", { method: "POST", headers: { "content-type": "image/png" }, body: png });
console.log("POST", m1.status, JSON.stringify(m1.body));
const m2 = await j("/mascot");
console.log("GET after", m2.status, m2.ct, m2.body.length);
const badCt = await j("/mascot", { method: "POST", headers: { "content-type": "text/plain" }, body: "hi" });
console.log("wrong ct (应 415)", badCt.status, JSON.stringify(badCt.body));

console.log(tag("avatar user/ai"));
const a1 = await j("/avatar/user", { method: "POST", headers: { "content-type": "image/jpeg" }, body: png });
console.log("POST user", a1.status, JSON.stringify(a1.body));
const a2 = await j("/avatar/ai");
console.log("GET ai (应 404)", a2.status);
const aBad = await j("/avatar/hacker");
console.log("bad side (应 404)", aBad.status);

console.log(tag("清理"));
console.log(JSON.stringify((await j("/mascot", { method: "DELETE" })).body));
console.log(JSON.stringify((await j("/avatar/user", { method: "DELETE" })).body));

console.log(tag("root"));
const root = await j("");
console.log(root.status, root.body.name, root.body.routes.length);

await s.close();
console.log("\nCLOSED");

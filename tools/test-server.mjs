import { createHostServer } from "../src/host/server.mjs";

const h = await createHostServer({ port: 0, log: (lvl, msg) => console.log("[" + lvl + "]", msg) });
const { port, url } = await h.listen(0);
console.log("LISTEN", url);

async function j(p) {
  const r = await fetch(url + p);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 200) }; }
}

const inv = await j("/wallpaper-engine/inventory");
console.log("INV status", inv.status, "total", inv.body?.total, "counts", JSON.stringify(inv.body?.counts));
console.log("first wallpaper", JSON.stringify(inv.body?.wallpapers?.[0]));

const st = await j("/wallpaper-engine/status");
console.log("STATUS", JSON.stringify(st.body?.stats));

const set = await j("/wallpaper-engine/settings");
console.log("SETTINGS groups", set.body?.groups?.length, "version", set.body?.version);

if (inv.body?.wallpapers?.[0]?.media) {
  const m = await fetch(url + inv.body.wallpapers[0].media, { headers: { range: "bytes=0-99" } });
  console.log("MEDIA", m.status, m.headers.get("content-type"), m.headers.get("content-range"), (await m.arrayBuffer()).byteLength, "bytes");
}

await h.close();
console.log("CLOSED");
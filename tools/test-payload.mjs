import { createHostServer } from "../src/host/server.mjs";
import { createController } from "../src/host/controller.mjs";
import { updateConfig, getConfig } from "../src/host/config.mjs";

const s = createHostServer({ port: 0 });
await s.listen(0);
const fakeInjector = { apply: async (p) => ({ ok: true, reused: false }), connected: true };
const c = createController({ server: s, injector: fakeInjector, log: (l, m) => console.log("[" + l + "]", m) });
const p = await c.buildPayload({});
console.log("版本", p.version);
console.log("mascot", JSON.stringify(p.mascot));
console.log("font", JSON.stringify(p.font));
console.log("wallpaper", p.wallpaper ? p.wallpaper.kind + " " + p.wallpaper.url.slice(0, 60) : null);

// 换字体 + 开吉祥物，验证载荷跟着变
updateConfig({ fontSetId: "compact", themeSize: { "markdown-h1": 26 }, ropeShown: true, avatarEnabled: true });
const p2 = await c.buildPayload({});
console.log("\nafter:", JSON.stringify(p2.font));
console.log("mascot2:", JSON.stringify(p2.mascot));
await s.close();

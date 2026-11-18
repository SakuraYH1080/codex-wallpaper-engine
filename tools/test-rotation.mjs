/**
 * tools/test-rotation.mjs —— 轮播组逻辑单测（不启 HTTP、不连 CDP）
 *
 * 覆盖 dsh 的四条口径：
 *   ① 组内成员才算候选（typeFilter 不影响轮播成员，issue #294）
 *   ② order=random 推进不会原地踏步
 *   ③ trigger=videoEnd 不计时（intervalMs = 0）
 *   ④ 无组时回落 pictureSlideSeconds；有组时用组的 interval（分钟）
 */
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cwe-rot-"));
process.env.CWE_DATA_DIR = tmp;
writeFileSync(join(tmp, "config.json"), JSON.stringify({ settingsVersion: 8 }));

const { createController } = await import("../src/host/controller.mjs");
const { updateConfig, getConfig } = await import("../src/host/config.mjs");

// 假宿主：清单里 4 条壁纸，其中 2 条不在组里
const rows = [
  { id: "a", title: "A", type: "image", media: "/m/a", playable: true, contentrating: null },
  { id: "b", title: "B", type: "video", media: "/m/b", mime: "video/mp4", playable: true, contentrating: null },
  { id: "c", title: "C", type: "image", media: "/m/c", playable: true, contentrating: null },
  { id: "d", title: "D", type: "image", media: "/m/d", playable: true, contentrating: "mature" },
];
const server = { url: "http://127.0.0.1:1", port: 1, inventory: { build: async () => ({ wallpapers: rows, total: rows.length }) } };
let applied = [];
const injector = { apply: async (p) => { applied.push(p); return { ok: true }; }, connected: true };
const ctl = createController({ server, injector, log: () => {} });

// ① 组 [a,b]，typeFilter 只留 image —— b 是 video 仍必须在候选里
updateConfig({
  id: "a",
  rotationEnabled: true,
  typeFilter: ["image"],
  rotationGroupId: "g1",
  rotationGroups: [{ id: "g1", name: "测试", interval: 5, order: "sequence", trigger: "interval", wallpaperIds: ["a", "b"] }],
});
let p = await ctl.buildPayload({});
console.log("① candidates:", p.rotation.candidates, "ids:", JSON.stringify(p.rotation.ids));
let ok1 = p.rotation.candidates === 2 && p.rotation.ids.join(",") === "a,b";

// ④ interval 是分钟
let ok4a = p.rotation.intervalMs === 5 * 60_000;

// ② 顺序推进 a → b
await ctl.buildPayload({ advance: true });
let after = getConfig().id;
let ok2 = after === "b";
console.log("② sequence advance a→", after);

// ② random 推进不会原地踏步（100 次里不该有一次停在原地）
updateConfig({ rotationGroups: [{ id: "g1", name: "测试", interval: 5, order: "random", trigger: "interval", wallpaperIds: ["a", "b"] }], id: "a" });
let stuck = 0;
for (let i = 0; i < 40; i++) {
  updateConfig({ id: "a" });
  await ctl.buildPayload({ advance: true });
  if (getConfig().id === "a") stuck++;
}
let ok2b = stuck === 0;
console.log("② random stuck count:", stuck, "(期望 0)");

// ③ videoEnd 不计时
updateConfig({ rotationGroups: [{ id: "g1", name: "测试", interval: 5, order: "sequence", trigger: "videoEnd", wallpaperIds: ["a", "b"] }] });
p = await ctl.buildPayload({});
let ok3 = p.rotation.intervalMs === 0 && p.rotation.trigger === "videoEnd";
console.log("③ videoEnd intervalMs:", p.rotation.intervalMs, "trigger:", p.rotation.trigger);

// ④ 无组回落 pictureSlideSeconds
updateConfig({ rotationGroups: [], rotationGroupId: "", pictureSlideSeconds: 7 });
p = await ctl.buildPayload({});
let ok4b = p.rotation.intervalMs === 7000;
console.log("④ fallback intervalMs:", p.rotation.intervalMs, "(期望 7000)");

// ① 补充：hiddenIds 排除
updateConfig({
  hiddenIds: ["b"],
  rotationGroupId: "g2",
  rotationGroups: [{ id: "g2", name: "测试2", interval: 5, order: "sequence", trigger: "interval", wallpaperIds: ["a", "b"] }],
  pictureSlideSeconds: 0,
});
p = await ctl.buildPayload({});
let ok5 = p.rotation.candidates === 1; // b 被隐藏 ⇒ 只剩 a
console.log("⑤ hidden 排除后 candidates:", p.rotation.candidates, "(期望 1)");

// 模拟旧的轮播清单晚到，不能覆盖一次更新的手动选择。
const pendingInventory = [];
server.inventory.build = () => new Promise((resolve) => pendingInventory.push(resolve));
const oldPush = ctl.push({ advance: true });
updateConfig({ id: "c" });
const newPush = ctl.push();
const inventory = { wallpapers: rows, total: rows.length };
pendingInventory[1](inventory);
await newPush;
pendingInventory[0](inventory);
const ok6 = (await oldPush).reason === "superseded" && applied.length === 1 &&
  applied[0].wallpaper.id === "c" && getConfig().id === "c";

await ctl.stop();
rmSync(tmp, { recursive: true, force: true });
const all = ok1 && ok2 && ok2b && ok3 && ok4a && ok4b && ok5 && ok6;
console.log("checks:", JSON.stringify({ ok1, ok2, ok2b, ok3, ok4a, ok4b, ok5, ok6 }));
console.log(all ? "ROTATION_TEST_PASS" : "ROTATION_TEST_FAIL");
process.exit(all ? 0 : 1);

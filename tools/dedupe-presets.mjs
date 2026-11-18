#!/usr/bin/env node
/**
 * 清掉「同一套观感被导入多次」留下的副本。
 *
 * 用法：
 *   node tools/dedupe-presets.mjs           # 只报告，不动盘
 *   node tools/dedupe-presets.mjs --apply   # 真合并；副本搬进 presets/.dedupe-<时间戳>/
 *
 * 判重口径和面板里的导入一致（归一化后深比较），每组保留 savedAt 最新的一条。
 * 被合并的副本不删除 —— 想找回来直接在上面那个目录里拿。
 */
import { dedupePresets, PRESET_DIR } from "../src/host/presets.mjs";

const apply = process.argv.includes("--apply");
const r = dedupePresets({ apply });

console.log("preset dir: " + PRESET_DIR);
console.log("total " + r.total + " → groups " + r.groups + "，重复副本 " + r.dropped.length + " 个");
for (const p of r.kept) console.log("  keep  " + p.id + "  " + p.name + "  " + (p.savedAt || ""));
for (const p of r.dropped) console.log("  drop  " + p.id + "  " + p.name + "  " + (p.savedAt || ""));
if (!r.dropped.length) console.log("没有重复，不用动。");
else if (r.trash) console.log("已搬走 → " + r.trash);
else console.log("这是预演。加 --apply 才会真的搬走。");

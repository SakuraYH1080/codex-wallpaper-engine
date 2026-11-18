/**
 * 外观预设：把「一套观感」存成一个可复用、可分享的 JSON。
 *
 * 三条设计约束（都是 dsh 原版踩出来的）：
 *   1) 只收外观键 —— 预设不该顺手改掉 cwePort / extraProjectDirs / hiddenIds 这类
 *      「这台机器的事实」。用 GROUPS 反推白名单，新增字段自动进预设，不用两处维护。
 *   2) 内置预设只读，用户层写到 <data>/presets/<id>.json；同 id 的用户预设遮蔽内置。
 *   3) 导入是不可信输入：先过 settings-schema 的 sanitize，再落盘、再应用。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DIRS } from "./data-dir.mjs";
import { GROUPS, sanitize, DEFAULTS } from "./settings-schema.mjs";

export const PRESET_DIR = join(DIRS.root, "presets");
export const PRESET_VERSION = 1;

/** 哪些键算「外观」：除 host 组以外的全部字段，再去掉与单台机器绑定的几个。 */
const NON_PRESET_KEYS = new Set([
  "id", "hiddenIds", "rotationGroups", "rotationGroupId", "rotationSeeded",
  "rotationEnabled", "rotationInterval", "pictureSlideSeconds",
  "settingsVersion", "noticeSeen",
]);

export function presetKeys() {
  const out = [];
  for (const g of GROUPS) {
    if (g.id === "host") continue;
    for (const f of g.fields) if (!NON_PRESET_KEYS.has(f.key)) out.push(f.key);
  }
  return out;
}

function ensureDir() {
  if (!existsSync(PRESET_DIR)) mkdirSync(PRESET_DIR, { recursive: true });
}

function safeId(id) {
  const s = String(id || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

/** 值深比较：预设 values 允许嵌套（rotationGroups 之类），JSON.stringify 比顺序不可靠。 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!a || !b || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

/**
 * 归一化：把一份（可能残缺的）预设 values 补成全量外观，用于跨版本比较。
 *
 * 旧预设只存过 49/56 键，而 importPreset 走 sanitize({...DEFAULTS}) + pickAppearance
 * 会补满 68 键 —— 直接 deepEqual 永远不等，同一个文件导八次就生成八条「导入的」。
 * 比较前两边都过这一道，才算在比「观感」而不是比「键的多少」。
 */
function normValues(values) {
  return pickAppearance(sanitize({ ...DEFAULTS, ...(values || {}) }));
}

/** 名字 → 文件名安全的一段。中文/全角全部落空，返回 "" 由调用方兜底成 "s"。 */
function slugOf(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/-+/g, "-").slice(0, 24);
}

function rand4() {
  return Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(0, 4).padEnd(4, "0");
}

/** 已落盘的用户预设（含 values），供 savePreset 判重名与幂等。 */
function listUserPresetsRaw() {
  ensureDir();
  let files = [];
  try { files = readdirSync(PRESET_DIR).filter((f) => f.endsWith(".json")); } catch {}
  const out = [];
  for (const f of files) {
    const got = readUserPreset(f.replace(/\.json$/, ""));
    if (got) out.push(got);
  }
  return out;
}

/** 落盘：先写临时文件再 rename，中途崩了也不会留下半个 JSON。 */
function writePresetDoc({ id, name, values, savedAt }) {
  const doc = { version: PRESET_VERSION, id, name, savedAt: savedAt || new Date().toISOString(), values };
  const tmp = join(PRESET_DIR, id + ".json.tmp-" + process.pid + "-" + Date.now().toString(36) + "-" + rand4());
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, join(PRESET_DIR, id + ".json"));
  return doc;
}

/**
 * 内置预设：不落盘，永远在，可被同 id 的用户预设遮蔽。
 *
 * ★ 键必须全落在 presetKeys() 里。曾经这里写过 border / blur —— 它们是 dsh 版的
 *   遗留字段，本项目 GROUPS 里没有，也不被 runtime 消费；结果是「应用能过、
 *   保存时被白名单静默丢掉」，导入导出还会回一句「忽略 2 个非外观键」。
 *   新增/修改内置预设后跑一次 tools/test-presets.mjs，它会核对这件事。
 */
export const BUILTIN_PRESETS = [
  {
    id: "glass-dark",
    name: "午夜玻璃",
    builtin: true,
    values: {
      // uiAlpha 必须和 uiAlphaMain 贴近：主内容面的暗底是 over = (uiAlpha - uiAlphaMain) / (1 - uiAlphaMain)，
      // 只降 uiAlphaMain 不降 uiAlpha，over 反而从 0.10 涨到 0.50，整块主区会压暗。
      cweUiAlpha: 0.30, cweUiAlphaMain: 0.24, scrim: 0.12, wallpaperOpacity: 100,
      wallpaperBlur: 6, backgroundBrightness: 88, backgroundContrast: 108, backgroundSaturate: 115,
      accent: "#67DCE7", sidebarGlass: true, sidebarAlpha: 22, sidebarBlur: 14,
      titlebarGlass: true, conversationSidebarGlass: true,
      conversationSidebarAlpha: 32, conversationSidebarBlur: 16,
      conversationSidebarTint: "#0a0e14", conversationSidebarSaturate: 165,
      conversationSidebarBrightness: 112, conversationSidebarEdge: true,
    },
  },
  {
    id: "clear-max",
    name: "全通透",
    builtin: true,
    values: {
      cweUiAlpha: 0.28, cweUiAlphaMain: 0.22, scrim: 0.1, wallpaperOpacity: 100,
      wallpaperBlur: 0, backgroundBrightness: 100, backgroundContrast: 100, backgroundSaturate: 100,
      sidebarGlass: true, sidebarAlpha: 22, sidebarBlur: 14, titlebarGlass: false, conversationSidebarGlass: true,
      conversationSidebarAlpha: 26, conversationSidebarBlur: 15,
      conversationSidebarTint: "#0a0e14", conversationSidebarSaturate: 170,
      conversationSidebarBrightness: 116, conversationSidebarEdge: true,
    },
  },
  {
    id: "plain",
    name: "原生观感",
    builtin: true,
    values: {
      cweUiAlpha: 0.97, cweUiAlphaMain: 0.97, scrim: 0, wallpaperOpacity: 0,
      wallpaperBlur: 0, sidebarGlass: false, titlebarGlass: false,
      conversationSidebarGlass: false, rightSidebarGlass: false, overlayGlass: false,
      fxEnabled: false, parallaxEnabled: false,
    },
  },
];

/** 从一个完整 config 里切出外观子集。 */
export function pickAppearance(cfg) {
  const out = {};
  for (const k of presetKeys()) {
    if (k in (cfg || {})) out[k] = cfg[k];
  }
  return out;
}

function readUserPreset(id) {
  const p = join(PRESET_DIR, id + ".json");
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    return { id, name: String(o.name || id), builtin: false, values: o.values || {}, savedAt: o.savedAt || null };
  } catch {
    return null;
  }
}

/**
 * 只看四个「一眼能认出来」的键。
 *
 * 起因：用户报「预设丢了」，实际是 18 张预设名字全叫「导入的」。列表里看不出
 * 哪套是哪套，于是即使文件都在也被读成"不见了"。名字是用户的资产，不能替他改，
 * 那就把观感摘要摆在名字下面 —— 透明度 / 模糊 / 亮度 / 对比度 四项足够区分。
 * 只回数字，不回整份 values（70 键 × N 套没必要进面板）。
 */
const PEEK_KEYS = ["wallpaperOpacity", "wallpaperBlur", "backgroundBrightness", "backgroundContrast"];

function peekValues(values) {
  const v = values || {};
  const out = {};
  for (const k of PEEK_KEYS) if (typeof v[k] === "number" && isFinite(v[k])) out[k] = v[k];
  return out;
}

export function listPresets() {
  // 用户预设在前、按 savedAt 倒序；内置三套固定垫后并保持声明顺序。
  // 旧实现是全局 name.localeCompare —— 16 个同名「导入的」会糊成一堆，看不出哪个是新存的。
  const users = listUserPresetsRaw()
    .map((p) => ({ id: p.id, name: p.name, builtin: false, keys: Object.keys(p.values).length, savedAt: p.savedAt, peek: peekValues(p.values) }))
    .sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")) || String(a.id).localeCompare(String(b.id)));
  const shadowed = new Set(users.map((u) => u.id));
  const builtins = BUILTIN_PRESETS
    .filter((b) => !shadowed.has(b.id))
    .map((b) => ({ id: b.id, name: b.name, builtin: true, keys: Object.keys(b.values).length, peek: peekValues(b.values) }));
  return [...users, ...builtins];
}

export function getPreset(id) {
  const key = safeId(id);
  if (!key) return null;
  const user = readUserPreset(key);
  if (user) return user;
  const b = BUILTIN_PRESETS.find((p) => p.id === key);
  return b ? { id: b.id, name: b.name, builtin: true, values: { ...b.values }, savedAt: null } : null;
}

/**
 * 保存当前外观为预设。
 *
 * 命名规则（真机 16 个预设全叫「导入的」踩出来的）：
 *   - 未给 id 时先查重名：同名且值深比较相同 → 直接返回已有项（幂等，不新建文件）；
 *     同名不同值 → 名字追加 ' · 2' / ' · 3'，直到找到空位或与已有项同值。
 *   - id = 'p-' + slug(或 's') + '-' + 时间戳36 + '-' + 4位随机：
 *     中文名也能得到合法文件名，且同一毫秒连存两次也不会撞。
 *   - 给了 id 且该用户预设已存在 = 更新那一套（改名/改值走这条）。
 */
export function savePreset({ id, name, values }) {
  ensureDir();
  const clean = {};
  const allowed = new Set(presetKeys());
  for (const [k, v] of Object.entries(values || {})) if (allowed.has(k)) clean[k] = v;

  const explicit = safeId(id);
  if (explicit && existsSync(join(PRESET_DIR, explicit + ".json"))) {
    const nm = String(name || "").trim().slice(0, 64) || explicit;
    writePresetDoc({ id: explicit, name: nm, values: clean });
    return { id: explicit, name: nm, builtin: false, keys: Object.keys(clean).length };
  }

  const base = (String(name || "").trim() || "未命名预设").slice(0, 60);
  const existing = listUserPresetsRaw();
  let nm = base;
  for (let i = 2; i < 999; i++) {
    const hit = existing.find((p) => p.name === nm);
    if (!hit) break;
    if (deepEqual(normValues(hit.values), normValues(clean))) {
      return { id: hit.id, name: hit.name, builtin: false, keys: Object.keys(hit.values).length, savedAt: hit.savedAt, existing: true };
    }
    nm = base + " · " + i;
  }
  const key = explicit || "p-" + (slugOf(nm) || "s") + "-" + Date.now().toString(36) + "-" + rand4();
  writePresetDoc({ id: key, name: nm, values: clean });
  return { id: key, name: nm, builtin: false, keys: Object.keys(clean).length };
}

export function deletePreset(id) {
  const key = safeId(id);
  if (!key) return { ok: false, error: "bad id" };
  const p = join(PRESET_DIR, key + ".json");
  if (!existsSync(p)) return { ok: false, error: "not-user-preset", builtin: !!getPreset(key) };
  unlinkSync(p);
  return { ok: true, removed: key };
}

/**
 * 改名：只改用户预设 JSON 里的 name，id 不动（URL / 外部引用不失效）。
 * 内置预设不可改名 —— 返回 error:"builtin"，由路由层映射成 409。
 */
export function renamePreset(id, name) {
  const key = safeId(id);
  if (!key) return { ok: false, error: "bad id" };
  const p = join(PRESET_DIR, key + ".json");
  if (!existsSync(p)) {
    const b = BUILTIN_PRESETS.find((x) => x.id === key);
    return { ok: false, error: b ? "builtin" : "not-user-preset" };
  }
  const nm = String(name == null ? "" : name).trim().slice(0, 64);
  if (!nm) return { ok: false, error: "empty name" };
  let doc;
  try { doc = JSON.parse(readFileSync(p, "utf8")); } catch { return { ok: false, error: "bad json" }; }
  doc.name = nm;
  const tmp = join(PRESET_DIR, key + ".json.tmp-" + process.pid + "-" + Date.now().toString(36) + "-" + rand4());
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, p);
  return { ok: true, preset: { id: key, name: nm, builtin: false, keys: Object.keys(doc.values || {}).length, savedAt: doc.savedAt || null } };
}

export function exportPreset(id) {
  const p = getPreset(id);
  if (!p) return null;
  return JSON.stringify({ version: PRESET_VERSION, id: p.id, name: p.name, savedAt: p.savedAt, values: p.values }, null, 2);
}

/** 导入：接受「裸 values」或完整预设文档；一律过 sanitize 再存。 */
export function importPreset(raw, fallbackName) {
  let o;
  try { o = typeof raw === "string" ? JSON.parse(raw) : raw; } catch {
    return { ok: false, error: "bad json" };
  }
  if (!o || typeof o !== "object") return { ok: false, error: "not an object" };
  const valuesIn = o.values && typeof o.values === "object" ? o.values : o;
  // sanitize 是整份配置的形状，这里喂进去能挡住所有越界值与未知键。
  const merged = sanitize({ ...DEFAULTS, ...valuesIn });
  const appearance = pickAppearance(merged);
  const kept = Object.keys(valuesIn).filter((k) => k in appearance);
  if (!kept.length) return { ok: false, error: "no known appearance keys" };
  const ignoredKeys = Object.keys(valuesIn).filter((k) => !(k in appearance));

  // 全库归一化去重：观感一样就不再落一条新文件，直接指回已有的那套。
  // 只扫用户预设 —— 内置三套不该被一次导入「固化成副本」。
  const same = listUserPresetsRaw().find((p) => deepEqual(normValues(p.values), appearance));
  if (same) {
    return {
      ok: true,
      existing: true,
      preset: { id: same.id, name: same.name, builtin: false, keys: Object.keys(same.values).length, savedAt: same.savedAt },
      applied: appearance,
      ignoredKeys,
    };
  }

  const saved = savePreset({ id: safeId(o.id) || undefined, name: o.name || fallbackName, values: appearance });
  return { ok: true, existing: !!saved.existing, preset: saved, applied: appearance, ignoredKeys };
}

/**
 * 合并「观感完全相同」的重复预设（历史上同一个文件反复导入留下的副本）。
 *
 * 判重口径与 importPreset 一致：先 normValues 再深比较 —— 只比「观感」，
 * 不比键的多少，也不比名字。每组保留 savedAt 最新的那一条。
 * apply=false 只报告；apply=true 把被合并的副本整个搬进 presets/.dedupe-<ts>/，
 * 不 unlink —— 目录名以点开头，listUserPresetsRaw 的 *.json 过滤不会读到它。
 */
export function dedupePresets({ apply = false } = {}) {
  ensureDir();
  const all = listUserPresetsRaw();
  const groups = new Map();
  for (const p of all) {
    const fp = JSON.stringify(normValues(p.values));
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(p);
  }
  const kept = [];
  const dropped = [];
  for (const list of groups.values()) {
    list.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")) || String(a.id).localeCompare(String(b.id)));
    kept.push(list[0]);
    for (const p of list.slice(1)) dropped.push(p);
  }
  let trash = null;
  if (apply && dropped.length) {
    trash = join(PRESET_DIR, ".dedupe-" + new Date().toISOString().replace(/[:.]/g, "-"));
    mkdirSync(trash, { recursive: true });
    for (const p of dropped) {
      const from = join(PRESET_DIR, p.id + ".json");
      if (existsSync(from)) renameSync(from, join(trash, p.id + ".json"));
    }
  }
  return {
    apply: !!apply,
    total: all.length,
    groups: groups.size,
    kept: kept.map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt })),
    dropped: dropped.map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt })),
    trash,
  };
}

export function ensurePresetDir() { ensureDir(); }

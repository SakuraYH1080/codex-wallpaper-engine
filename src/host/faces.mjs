/**
 * 吉祥物 / 头像 / 字体集 三块「用户上传的资源面」（移植 dsh 的 mascot-avatar 与 fonts 子包）。
 *
 * 三条不变量（从上游照抄，理由都写在这里）：
 *  1. 文件名永远由服务端铸造（stamp + 随机后缀），**绝不使用请求里的任何字符串拼路径** ——
 *     路径段只当白名单键查表（mascot 只有一张，avatar 只有 user/ai 两槽），
 *     所以「../../etc/passwd」连形状都过不了。
 *  2. 同族旧文件在写新文件之前清掉，且清的时候只认本族前缀 —— 否则会误删用户别的图。
 *  3. 落盘一律 .tmp + rename；读路径永不抛。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIRS } from "./data-dir.mjs";

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const EXT_BY_MIME = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" };
const MIME_BY_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
export const AVATAR_SIDES = ["user", "ai"];

function stamp() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function atomicWrite(path, buf) {
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, buf);
  renameSync(tmp, path);
}

function listDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function newest(dir, prefix, exts) {
  let best = null;
  for (const name of listDir(dir)) {
    if (!name.startsWith(prefix)) continue;
    const ext = extname(name).slice(1).toLowerCase();
    if (!exts.includes(ext)) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { abs, name, ext, size: st.size, mtime: st.mtimeMs };
  }
  return best;
}

export function mimeOfExt(ext) {
  return MIME_BY_EXT[String(ext || "").toLowerCase()] || "application/octet-stream";
}

/** 请求头里的 Content-Type 只取主类型比对；带 charset 等参数也能过。 */
export function extFromContentType(ct) {
  const head = String(ct || "").split(";")[0].trim().toLowerCase();
  return EXT_BY_MIME[head] || null;
}

// ---------------- 吉祥物（单张） ----------------

export function mascotCurrent() {
  return newest(DIRS.mascot, "mascot-", ["jpg", "jpeg", "png", "webp"]);
}

export function mascotSet(buf, ext) {
  mkdirSync(DIRS.mascot, { recursive: true });
  for (const name of listDir(DIRS.mascot)) {
    if (!name.startsWith("mascot-")) continue;
    try { unlinkSync(join(DIRS.mascot, name)); } catch {}
  }
  const name = "mascot-" + stamp() + "." + ext;
  const abs = join(DIRS.mascot, name);
  atomicWrite(abs, buf);
  return { ok: true, name, bytes: buf.length, ext };
}

export function mascotRemove() {
  const cur = mascotCurrent();
  if (!cur) return { ok: true, removed: null };
  try { unlinkSync(cur.abs); } catch {}
  return { ok: true, removed: cur.name };
}

// ---------------- 头像（user / ai 两槽） ----------------

export function avatarCurrent(side) {
  if (!AVATAR_SIDES.includes(side)) return null;
  return newest(DIRS.avatars, side + "-", ["jpg", "jpeg", "png", "webp"]);
}

export function avatarSet(side, buf, ext) {
  if (!AVATAR_SIDES.includes(side)) return { ok: false, error: "bad side" };
  mkdirSync(DIRS.avatars, { recursive: true });
  for (const name of listDir(DIRS.avatars)) {
    if (name.slice(0, side.length + 1) !== side + "-") continue;
    try { unlinkSync(join(DIRS.avatars, name)); } catch {}
  }
  const name = side + "-" + stamp() + "." + ext;
  const abs = join(DIRS.avatars, name);
  atomicWrite(abs, buf);
  return { ok: true, side, name, bytes: buf.length, ext };
}

export function avatarRemove(side) {
  if (!AVATAR_SIDES.includes(side)) return { ok: false, error: "bad side" };
  const cur = avatarCurrent(side);
  if (!cur) return { ok: true, removed: null };
  try { unlinkSync(cur.abs); } catch {}
  return { ok: true, removed: cur.name };
}

// ---------------- 字体集（随包层只读 + 用户层可写） ----------------

const FONTSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const BUILTIN_DIR = join(HERE, "..", "..", "assets", "fontsets");

export function isFontSetId(id) {
  return typeof id === "string" && FONTSET_ID_RE.test(id);
}

export function fontsetDirs() {
  return { builtin: BUILTIN_DIR, user: DIRS.fonts };
}

function readJsonFile(abs) {
  try {
    const o = JSON.parse(readFileSync(abs, "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

/** 两侧同名时用户层遮住随包层；返回 [{id,source,name,values}] 排序稳定。 */
export function fontsetList() {
  const dirs = fontsetDirs();
  const map = new Map();
  for (const [source, dir] of [["builtin", dirs.builtin], ["user", dirs.user]]) {
    for (const name of listDir(dir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isFontSetId(id)) continue;
      const doc = readJsonFile(join(dir, name));
      if (!doc) continue;
      map.set(id, { id, source, name: typeof doc.name === "string" ? doc.name : id, values: doc.values && typeof doc.values === "object" ? doc.values : {} });
    }
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function fontsetGet(id) {
  if (!isFontSetId(id)) return null;
  const dirs = fontsetDirs();
  const user = readJsonFile(join(dirs.user, id + ".json"));
  if (user) return { id, source: "user", doc: user, shadowed: existsSync(join(dirs.builtin, id + ".json")) };
  const builtin = readJsonFile(join(dirs.builtin, id + ".json"));
  if (builtin) return { id, source: "builtin", doc: builtin, shadowed: false };
  return null;
}

export function fontsetPut(id, doc) {
  if (!isFontSetId(id)) return { ok: false, error: "bad id" };
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, error: "bad doc" };
  const values = doc.values && typeof doc.values === "object" && !Array.isArray(doc.values) ? doc.values : {};
  const out = {
    $schema: typeof doc.$schema === "string" ? doc.$schema : "dsh-we/fontset@1",
    id,
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name.trim().slice(0, 64) : id,
    values: {
      themeColors: values.themeColors && typeof values.themeColors === "object" ? values.themeColors : {},
      themeDarkSeparate: !!values.themeDarkSeparate,
      themeSize: values.themeSize && typeof values.themeSize === "object" ? values.themeSize : {},
      themeWeight: values.themeWeight && typeof values.themeWeight === "object" ? values.themeWeight : {},
      themeFamily: values.themeFamily && typeof values.themeFamily === "object" ? values.themeFamily : {},
      componentFonts: values.componentFonts && typeof values.componentFonts === "object" ? values.componentFonts : {},
    },
  };
  mkdirSync(DIRS.fonts, { recursive: true });
  atomicWrite(join(DIRS.fonts, id + ".json"), Buffer.from(JSON.stringify(out, null, 2), "utf8"));
  return { ok: true, id, source: "user" };
}

export function fontsetDelete(id) {
  if (!isFontSetId(id)) return { ok: false, error: "bad id" };
  const userPath = join(DIRS.fonts, id + ".json");
  const builtinPath = join(fontsetDirs().builtin, id + ".json");
  if (!existsSync(userPath)) {
    return { ok: false, error: "not-user-layer", builtin: existsSync(builtinPath) };
  }
  try { unlinkSync(userPath); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  return { ok: true, removed: id, restored: existsSync(builtinPath) };
}

// ---------------- 系统字体扫描（带 TTL + stale-while-revalidate） ----------------

const SYS_FONT_TTL_MS = 10 * 60 * 1000;
let sysCache = { at: 0, payload: null, scanning: null };

function scanSystemFonts() {
  const env = process.env.CWE_SYSTEM_FONTS;
  if (env) return { fonts: env.split(",").map((s) => s.trim()).filter(Boolean), source: "env", approximate: false };
  if (process.platform === "darwin") {
    // macOS：从标准字体目录列文件名。这是「近似」清单 —— 取不到字体的真实家族名，
    // 但对「给界面挑一个中文字体」这个用途够了，所以 payload 里带 approximate:true 让上层如实标注。
    const names = new Set();
    for (const dir of ["/System/Library/Fonts", "/Library/Fonts", join(process.env.HOME || "", "Library/Fonts")]) {
      for (const f of listDir(dir)) {
        const base = f.replace(/\.(ttf|ttc|otf|dfont)$/i, "");
        if (!base || base.startsWith(".") || base === f) continue;
        names.add(base);
      }
    }
    return { fonts: [...names].sort(), source: "macos-font-dirs", approximate: true };
  }
  if (process.platform === "win32") {
    const names = new Set();
    for (const f of listDir("C:\\Windows\\Fonts")) {
      const base = f.replace(/\.(ttf|ttc|otf|fon)$/i, "");
      if (base && base !== f) names.add(base);
    }
    return { fonts: [...names].sort(), source: "windows-fonts", approximate: true };
  }
  // Linux：fc-list 直接给家族名，属于精确清单，不需要近似标注。
  let out = [];
  try {
    out = String(execFileSync("fc-list", [":", "family"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).split("\n");
  } catch {}
  return { fonts: [...new Set(out.map((s) => s.split(",")[0].trim()).filter(Boolean))].sort(), source: "fc-list", approximate: false };
}

export function systemFonts({ refresh = false } = {}) {
  const now = Date.now();
  const fresh = sysCache.payload && now - sysCache.at < SYS_FONT_TTL_MS;
  if (fresh && !refresh) return { ...sysCache.payload, stale: false };
  if (!refresh) {
    if (sysCache.payload) {
      const payload = sysCache.payload;
      queueScan();
      return { ...payload, stale: true };
    }
  }
  try {
    const scanned = scanSystemFonts();
    // 空清单不落盘：下次一问就重扫，避免把「扫失败」固化成十分钟的假结论。
    if (scanned.fonts.length) {
      sysCache = { at: now, payload: { ok: true, ...scanned, scannedAt: now }, scanning: null };
    }
    return { ok: true, ...scanned, scannedAt: now, stale: false };
  } catch (e) {
    return { ok: false, fonts: [], source: "error", approximate: true, scannedAt: now, stale: false, error: String(e && e.message || e) };
  }
}

function queueScan() {
  if (sysCache.scanning) return;
  sysCache.scanning = setTimeout(() => {
    sysCache.scanning = null;
    try {
      const scanned = scanSystemFonts();
      if (scanned.fonts.length) sysCache = { at: Date.now(), payload: { ok: true, ...scanned, scannedAt: Date.now() }, scanning: null };
    } catch {}
  }, 50);
  if (sysCache.scanning.unref) sysCache.scanning.unref();
}

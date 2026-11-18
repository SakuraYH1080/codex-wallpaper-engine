/**
 * 上传目录与元数据账本（移植 dsh 的 upload-store.js + upload-dir.js 语义）。
 *
 * 不变量（照抄上游，任何一条放松都会静默丢数据）：
 *  1. 所有写都进同一串行队列（enqueueWrite）：「读整份 → 改一条 → 原子写回」三步不得交错。
 *  2. 落盘一律 .tmp + rename，崩溃不留半截 JSON。
 *  3. 读路径永不抛：缺失 / 坏 JSON / 非对象 → {}。
 *  4. 目录只经访问器 getUploadDir() 取 —— 运行期可被 setUploadDir 改写。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { DIRS } from "./data-dir.mjs";
import { getConfig, updateConfig } from "./config.mjs";
import { naturalCompare } from "./fs-paths.mjs";

/**
 * 单个上传文件的上限。
 *
 * 早先写死 512MB —— 一条 1080p / 20Mbps 的 4 分钟视频就是 557MB，直接被 413 挡在门外；
 * 而面板只显示「上传失败」，用户完全看不出是体积问题（这就是「导入视频壁纸没显示」那次报障的根因）。
 * 现在放宽到 2GB，并把上限值导出给文案用，免得错误提示里再写一份魔法数字。
 *
 * 注意：落盘已改成流式（server.mjs handleUpload），内存占用与文件大小无关，
 * 所以放宽上限不会让宿主堆跟着涨。
 */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_MAX_LABEL = "2GB";
const UPLOAD_FILE_RE = /^(up-[a-z0-9-]+)\.(mp4|webm|jpg|jpeg|png|gif|webp|avif)$/i;
export const PREVIEW_CANDIDATES = ["preview.jpg", "preview.png", "preview.gif", "preview.webp"];

let UPLOAD_DIR = resolveUploadDir();

export function defaultUploadDir() { return join(DIRS.root, "uploads"); }

export function resolveUploadDir() {
  if (process.env.CWE_UPLOAD_DIR) return process.env.CWE_UPLOAD_DIR;
  const cfg = getConfig();
  if (cfg && typeof cfg.uploadDir === "string" && cfg.uploadDir.trim()) return cfg.uploadDir.trim();
  return defaultUploadDir();
}

export function getUploadDir() { return UPLOAD_DIR; }

export function setUploadDir(dir) {
  if (typeof dir !== "string" || !dir.trim()) return { ok: false, error: "bad dir" };
  const target = dir.trim();
  mkdirSync(target, { recursive: true });
  UPLOAD_DIR = target;
  updateConfig({ uploadDir: target });
  return { ok: true, uploadDir: UPLOAD_DIR };
}

export function ensureUploadDir() {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

function uploadMetaPath() { return join(UPLOAD_DIR, ".meta.json"); }

export function readUploadMeta() {
  const p = uploadMetaPath();
  if (!existsSync(p)) return {};
  try {
    const o = JSON.parse(readFileSync(p, "utf8"));
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}

export function metaEntry(meta, id) {
  const v = meta[id];
  if (typeof v === "string") return { title: v, sha256: null, contentrating: null };
  if (v && typeof v === "object") return {
    title: typeof v.title === "string" && v.title.trim() ? v.title : id,
    sha256: typeof v.sha256 === "string" ? v.sha256 : null,
    contentrating: typeof v.contentrating === "string" && v.contentrating.trim() ? v.contentrating.trim() : null,
  };
  return { title: id, sha256: null, contentrating: null };
}

// ---- 串行写队列（与 config.json 共用纪律：一次只跑一个写） ----
let chain = Promise.resolve();
export function enqueueWrite(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

function atomicWriteSync(path, text) {
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

export function setUploadMeta(id, title, sha256, contentrating = null) {
  return enqueueWrite(() => {
    try {
      const m = readUploadMeta();
      m[id] = { title: title || id, sha256: sha256 || null };
      if (contentrating) m[id].contentrating = contentrating;
      atomicWriteSync(uploadMetaPath(), JSON.stringify(m));
    } catch {}
  });
}

export function removeUploadMeta(id) {
  return enqueueWrite(() => {
    try {
      const m = readUploadMeta();
      if (id in m) { delete m[id]; atomicWriteSync(uploadMetaPath(), JSON.stringify(m)); }
    } catch {}
  });
}

/** 上传 id → 绝对路径；不合法或越界返回 null。 */
export function resolveUploadFile(dir, id) {
  if (typeof id !== "string" || !/^up-[a-z0-9-]+$/.test(id)) return null;
  const root = normalize(dir);
  try {
    for (const entry of readdirSync(dir)) {
      const m = UPLOAD_FILE_RE.exec(entry);
      if (m && m[1].toLowerCase() === id.toLowerCase()) {
        const abs = normalize(join(dir, entry));
        const rel = relative(root, abs);
        if (!rel || rel.startsWith("..") || /^[\\/]/.test(rel)) return null;
        return abs;
      }
    }
  } catch { return null; }
  return null;
}

/** 枚举单文件上传（不含 __ 前缀的辅助文件与 .meta.json）。 */
export function enumerateUploads(dir = UPLOAD_DIR) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const m = UPLOAD_FILE_RE.exec(name);
    if (!m) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ id: m[1], file: abs, ext: m[2].toLowerCase(), size: st.size, mtime: st.mtimeMs });
  }
  out.sort((a, b) => naturalCompare(a.id, b.id));
  return out;
}

/** 用一个稳定 id 生成上传落盘路径。<id>.<ext> */
export function makeUploadId() {
  const s = Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 6);
  return "up-" + s;
}

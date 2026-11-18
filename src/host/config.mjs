import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, sanitize, SETTINGS_VERSION } from "./settings-schema.mjs";
import { DIRS, DSH_DATA_ROOT, ensureDataDirs } from "./data-dir.mjs";

const CONFIG_PATH = join(DIRS.root, "config.json");

let cached = null;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 首次运行：如果本机有 dsh-wallpaper-engine 的配置，把壁纸选择和外观设置搬过来。 */
function importFromDsh() {
  const src = join(DSH_DATA_ROOT, "config.json");
  if (!existsSync(src)) return null;
  const dsh = readJson(src);
  if (!dsh || typeof dsh !== "object") return null;
  // 字段名一一对应，只补 Codex 专属默认值；id 先清空，等 inventory 校验后再认。
  const migrated = { ...dsh, id: "", noticeSeen: "", cweEnabled: true };
  return migrated;
}

export function loadConfig({ migrate = true } = {}) {
  ensureDataDirs();
  const onDisk = readJson(CONFIG_PATH);
  if (onDisk) {
    cached = sanitize(onDisk);
    return cached;
  }
  const migrated = migrate ? importFromDsh() : null;
  cached = sanitize(migrated || DEFAULTS);
  if (migrated) cached.migratedFromDsh = true;
  saveConfig(cached);
  return cached;
}

export function getConfig() {
  return cached || loadConfig();
}

/**
 * 合并式更新：只接受传入的 key，其余保持不变。
 * 写盘用 tmp + rename，避免半截文件把配置写坏。
 */
export function updateConfig(patch) {
  const cur = getConfig();
  const next = sanitize({ ...cur, ...patch });
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, CONFIG_PATH);
  cached = next;
  return next;
}

export function saveConfig(cfg) {
  ensureDataDirs();
  const clean = sanitize(cfg);
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(clean, null, 2));
  renameSync(tmp, CONFIG_PATH);
  cached = clean;
  return clean;
}

export function resetConfig() {
  const backup = CONFIG_PATH + ".bak-" + Date.now();
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, backup);
  cached = sanitize(DEFAULTS);
  saveConfig(cached);
  return { config: cached, backup };
}

export { CONFIG_PATH, SETTINGS_VERSION };

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const HOME = homedir();

/** 本插件自己的数据根。与 Codex 的 ~/.codex 分开，卸载时只删这里。 */
export const DATA_ROOT = process.env.CWE_DATA_DIR || join(HOME, ".codex-wallpaper-engine");

/** dsh-wallpaper-engine 的数据根，用于首次导入用户已有壁纸与设置。 */
export const DSH_DATA_ROOT = process.env.DSH_WE_DATA_DIR || join(HOME, ".dsh-wallpaper-engine");

export const DIRS = {
  root: DATA_ROOT,
  uploads: join(DATA_ROOT, "uploads"),
  thumbs: join(DATA_ROOT, "thumbs"),
  cache: join(DATA_ROOT, "cache"),
  transcoded: join(DATA_ROOT, "transcoded"),
  avatars: join(DATA_ROOT, "avatars"),
  fonts: join(DATA_ROOT, "fonts"),
  mascot: join(DATA_ROOT, "mascot"),
  diag: join(DATA_ROOT, "diag"),
  ffmpeg: join(DATA_ROOT, "ffmpeg"),
};

export function ensureDataDirs() {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return DIRS;
}

export function isMac() { return platform() === "darwin"; }
export function isWin() { return platform() === "win32"; }

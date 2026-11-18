/**
 * 文件系统小工具 + 路径语义（零依赖）。
 *
 * 为什么单独成模块：扫描族、清单族、媒体族、缓存族都要用同一套「存在性 / 是文件 / 是目录」
 * 与「扩展名」判定。各抄一份的后果是路径语义分叉 —— 一处认为 .PNG 是图片、另一处不认。
 */

import { stat } from "node:fs/promises";
import { extname } from "node:path";

export async function pathExistsP(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isFileP(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectoryP(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 小写扩展名（含点）；无扩展名返回空串。 */
export function extOf(file) {
  return extname(String(file || "")).toLowerCase();
}

/** 数字序号的自然序比较器（1.jpg < 2.jpg < 10.jpg）。 */
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * WE 的 schemecolor 是 "r g b"（0..1 浮点、空格分隔，元素可能带尾随 0）。
 * 转成 CSS rgb()；不合法返回 null。
 */
export function schemeToCss(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const to255 = (n) => Math.max(0, Math.min(255, Math.round(n * 255)));
  return `rgb(${to255(parts[0])}, ${to255(parts[1])}, ${to255(parts[2])})`;
}

/**
 * 目录包含校验：abs 必须落在 dir 内（不含 dir 本身）。
 * project.json 的 file / preview / preset.customdirectory 是外部可控输入（创意工坊上传者随便写），
 * 不过这一关就等于把 /media、/preview 变成任意文件读取器。
 */
export function containedInDir(dir, abs) {
  const rel = relativeSafe(dir, abs);
  if (rel === null) return false;
  return rel !== "" && !rel.startsWith("..") && !isAbsolutePath(rel);
}

function relativeSafe(dir, abs) {
  try {
    return relativeRaw(dir, abs);
  } catch {
    return null;
  }
}

import { relative as relativeRaw, isAbsolute as isAbsolutePath } from "node:path";

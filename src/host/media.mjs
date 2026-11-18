/**
 * 媒体响应族：MIME 判定 + Range 处理 + 统一 CORS。
 *
 * 为什么单独成模块：清单族、预览族、场景族、上传族四条路都要发文件字节，
 * 而 Range 只要有一族漏掉，对应控件就静默坏掉（<video> 拖不动进度、音频不能跳）。
 * 所以「发字节」只留这一处实现。
 */
import { createReadStream, createWriteStream, renameSync, statSync, unlinkSync } from "node:fs";
import { extname } from "node:path";

const MIME = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(absPath) {
  return MIME[extname(String(absPath || "")).toLowerCase()] || "application/octet-stream";
}

export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, range, x-cwe-token, x-requested-with");
  // DELETE 必须列进来：预设删除和资源清除都走 DELETE，页面发的是跨源请求，
  // 浏览器先发 preflight，Allow-Methods 里没有 DELETE 就会直接报 Failed to fetch。
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "content-length, content-range, accept-ranges");
}

/** 解析 Range 头。返回 {start,end} / null（无 Range）/ "unsatisfiable"。 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  let start;
  let end;
  if (!hasStart && hasEnd) {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || start < 0) return "unsatisfiable";
    if (end >= size) end = size - 1;
    if (start > end || start >= size) return "unsatisfiable";
  }
  return { start, end };
}

/**
 * 发文件。带体 GET（含 Range）算一次传输；served 只增不减。
 * head=true 时只发头（HEAD 语义）。
 */
export function serveFile(req, res, absPath, { cacheControl = "no-cache", stat = null, onServed = null } = {}) {
  let st = stat;
  if (!st) {
    try {
      st = statSync(absPath);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return false;
    }
  }
  if (!st.isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return false;
  }
  const size = st.size;
  setCors(res);
  res.setHeader("Content-Type", mimeFor(absPath));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Last-Modified", st.mtime.toUTCString());

  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return false;
  }

  const head = req.method === "HEAD";
  if (!range) {
    res.writeHead(200, { "Content-Length": String(size) });
    if (head) { res.end(); return true; }
    const stream = createReadStream(absPath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    if (onServed) onServed(size);
    return true;
  }

  const { start, end } = range;
  const len = end - start + 1;
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": String(len),
  });
  if (head) { res.end(); return true; }
  const stream = createReadStream(absPath, { start, end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  if (onServed) onServed(len);
  return true;
}

export function sendText(res, code, body, type = "text/plain; charset=utf-8") {
  setCors(res);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

export function sendJson(res, code, payload, cacheControl = "no-store") {
  setCors(res);
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": cacheControl,
  });
  res.end(body);
}

/**
 * 把请求体直接流进文件（带上限）。返回 { bytes } / { error }。
 *
 * 为什么要有这条：readBody 是「全读进内存再写盘」，一个 557MB 的视频壁纸就是 557MB 常驻堆，
 * 上限一放宽（512MB → 2GB）这条就更不能留。落盘走 .part 临时文件，写完再 rename，
 * 中途超限或断连都只删临时文件，绝不留下半截 .mp4 被清单扫进去。
 *
 * 超限时立刻 req.destroy() —— 不把剩下的字节白读一遍，客户端能马上看到 413。
 */
export function pipeBodyToFile(req, absPath, maxBytes) {
  return new Promise((resolve) => {
    const part = absPath + ".part";
    let out;
    try { out = createWriteStream(part); } catch (err) { resolve({ error: "open failed: " + err.message }); return; }
    let total = 0;
    let settled = false;
    const fail = (why, over) => {
      if (settled) return;
      settled = true;
      out.destroy();
      try { unlinkSync(part); } catch {}
      resolve({ error: why, over: !!over });
    };
    req.on("data", (c) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) { fail("too large", true); try { req.destroy(); } catch {} return; }
      if (!out.write(c)) { req.pause(); out.once("drain", () => { try { req.resume(); } catch {} }); }
    });
    req.on("end", () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        try { renameSync(part, absPath); } catch (err) { try { unlinkSync(part); } catch {} resolve({ error: "rename failed: " + err.message }); return; }
        resolve({ bytes: total });
      });
    });
    req.on("error", () => fail("aborted"));
    out.on("error", (err) => fail("write failed: " + err.message));
  });
}

/** 读请求体（带上限）。返回 Buffer 或 null（超限）。 */
export function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      total += c.length;
      if (total > maxBytes) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

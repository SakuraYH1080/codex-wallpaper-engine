/**
 * src/host/server.mjs —— 宿主 HTTP 服务（移植 dsh 的 routes 面，去掉 ctx.webServer 依赖）
 *
 * 为什么要有这一层：Codex 的页面 CSP 把 connect-src 限死，注入层唯一能拿数据的通道
 * 就是本地 loopback HTTP。所以宿主必须自己起一个 127.0.0.1 服务，把「清单 / 媒体 /
 * 上传 / 设置 / 外观资源」各族挂在 /wallpaper-engine/* 下。
 *
 * 这一版只服务用户自己上传的壁纸与外观设置：早先还有一族「场景 / 网页工程」的
 * 静态资源路由（scene-live / scene-engine / scene-files / web），随 Steam 与
 * Wallpaper Engine 连接一起删掉了 —— 那三族只为 WE 工程服务，本地没有第二个调用方。
 *
 * 四条纪律（任何一条放松都会静默坏掉）：
 *   1. 所有对外 URL 一律带 token；清单里绝不出现真实路径。
 *   2. 发文件只经 media.serveFile 一处实现 —— Range 只有一份，漏一族就等于 <video> 拖不动。
 *   3. 目录逃逸必须挡：main.js 里那族相对路径一律 containedInDir 校验。
 *   4. 服务只绑 127.0.0.1，不绑 0.0.0.0（这是本机应用，不是服务器）。
 */

import { createServer } from "node:http";
import { readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { DIRS, ensureDataDirs } from "./data-dir.mjs";
import { getConfig, loadConfig, updateConfig, resetConfig, CONFIG_PATH } from "./config.mjs";
import { DEFAULTS, GROUPS, SETTINGS_VERSION, sanitize } from "./settings-schema.mjs";
import { createTokenStore } from "./tokens.mjs";
import { createInventory } from "./inventory.mjs";
import {
  getUploadDir,
  setUploadDir,
  ensureUploadDir,
  enumerateUploads,
  setUploadMeta,
  removeUploadMeta,
  resolveUploadFile,
  makeUploadId,
  readUploadMeta,
  metaEntry,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_LABEL,
} from "./uploads.mjs";
import { serveFile, sendJson, sendText, readBody, pipeBodyToFile, setCors } from "./media.mjs";
import { createFaceHandlers } from "./routes-faces.mjs";
import { listPresets, getPreset, savePreset, deletePreset, exportPreset, importPreset, renamePreset, pickAppearance, presetKeys } from "./presets.mjs";

export const PREFIX = "/wallpaper-engine";

export function createHostServer({ port = 9333, host = "127.0.0.1", log = () => {}, onEvent = null } = {}) {
  ensureDataDirs();
  loadConfig();

  const tokens = createTokenStore();

  // 清单只有一个数据源：上传目录。定位 Steam 库、扫 WE 工程、探测 scene 包内嵌视频
  // 这三件事随 Wallpaper Engine 连接一起删掉了 —— 本地不再有第二个调用方。
  const inventory = createInventory({
    log,
    tokenFor: (abs, kind, extra) => tokens.tokenFor(abs, kind, extra),
  });

  const stats = { startedAt: Date.now(), requests: 0, served: 0, servedBytes: 0, uploads: 0, errors: [] };

  // 用户资源面（吉祥物 / 头像 / 字体集 / 系统字体）四族路由，独立成文件。
  const faces = createFaceHandlers({ log, onEvent });

  function noteError(where, err) {
    const msg = where + ": " + (err && err.message || err);
    stats.errors.push({ at: Date.now(), msg });
    if (stats.errors.length > 50) stats.errors.shift();
    log("error", msg);
  }

  // ---------------- 路由 ----------------

  async function handleInventory(req, res) {
    const payload = await inventory.build();
    sendJson(res, 200, payload, "no-store");
  }

  function handleMedia(req, res, token) {
    const e = tokens.get(token);
    if (!e) return sendText(res, 404, "unknown token");
    return serveFile(req, res, e.abs, {
      cacheControl: "public, max-age=3600",
      onServed: (n) => { stats.served++; stats.servedBytes += n; },
    });
  }

  function handlePreview(req, res, token) {
    const e = tokens.get(token);
    if (!e) return sendText(res, 404, "unknown token");
    return serveFile(req, res, e.abs, {
      cacheControl: "public, max-age=600",
      onServed: (n) => { stats.served++; stats.servedBytes += n; },
    });
  }

  function handleSettingsGet(req, res) {
    const cfg = getConfig();
    sendJson(res, 200, {
      version: SETTINGS_VERSION,
      config: cfg,
      defaults: DEFAULTS,
      groups: GROUPS,
      configPath: CONFIG_PATH,
      uploadDir: getUploadDir(),
      cacheDir: DIRS.cache,
      dataRoot: DIRS.root,
    });
  }

  async function handleSettingsPost(req, res) {
    const body = await readBody(req, 64 * 1024);
    if (body === null) return sendJson(res, 413, { ok: false, error: "body too large" });
    let patch;
    try { patch = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
    if (!patch || typeof patch !== "object") return sendJson(res, 400, { ok: false, error: "bad patch" });
    const next = updateConfig(patch);
    if (onEvent) onEvent({ type: "settings", patch, config: next });
    sendJson(res, 200, { ok: true, config: next });
  }

  function handleSettingsReset(req, res) {
    const out = resetConfig();
    if (onEvent) onEvent({ type: "settings", patch: null, config: out.config, reset: true });
    sendJson(res, 200, { ok: true, ...out });
  }

  async function handleUpload(req, res, url) {
    const max = UPLOAD_MAX_BYTES;
    const name = String(url.searchParams.get("name") || "upload.bin");
    const title = String(url.searchParams.get("title") || "").slice(0, 200);
    const rating = url.searchParams.get("rating") || null;
    const ext = (extname(name) || "").toLowerCase();
    if (!/\.(mp4|webm|jpg|jpeg|png|gif|webp|avif)$/i.test(ext)) return sendJson(res, 400, { ok: false, error: "unsupported type " + ext });

    // 流式落盘：边收边写，内存占用与文件大小无关。
    // 早先这里是 readBody 全读进内存再 writeFileSync —— 放宽上限之后那样会直接把堆撑爆。
    const dir = ensureUploadDir();
    const id = makeUploadId();
    const file = join(dir, id + ext);
    const got = await pipeBodyToFile(req, file, max);
    if (got.error) {
      if (got.over) return sendJson(res, 413, { ok: false, error: "file too large (max " + UPLOAD_MAX_LABEL + ")" });
      noteError("upload write", got.error);
      return sendJson(res, 500, { ok: false, error: "write failed" });
    }
    if (!got.bytes) {
      try { unlinkSync(file); } catch {}
      return sendJson(res, 400, { ok: false, error: "empty body" });
    }
    await setUploadMeta(id, title || name, null, rating);
    inventory.invalidate();
    stats.uploads++;
    if (onEvent) onEvent({ type: "upload", id, file });
    sendJson(res, 200, { ok: true, id, file: id + ext, bytes: got.bytes });
  }

  async function handleRemove(req, res) {
    const body = await readBody(req, 64 * 1024);
    if (body === null) return sendJson(res, 413, { ok: false, error: "too large" });
    let payload;
    try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
    const id = String(payload.id || "");
    if (!/^up-[a-z0-9-]+$/i.test(id)) return sendJson(res, 400, { ok: false, error: "bad id" });
    const dir = getUploadDir();
    const abs = resolveUploadFile(dir, id);
    let removed = false;
    if (abs) {
      try { unlinkSync(abs); removed = true; } catch (err) { noteError("unlink", err); }
    }
    await removeUploadMeta(id);
    inventory.invalidate();
    if (onEvent) onEvent({ type: "remove", id });
    sendJson(res, 200, { ok: true, removed });
  }

  function handleUploadDirGet(req, res) {
    sendJson(res, 200, { ok: true, uploadDir: getUploadDir(), files: enumerateUploads(getUploadDir()).map((f) => ({ id: f.id, ext: f.ext, size: f.size })) });
  }

  async function handleUploadDirPost(req, res) {
    const body = await readBody(req, 64 * 1024);
    if (body === null) return sendJson(res, 413, { ok: false, error: "too large" });
    let payload;
    try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
    const dir = String(payload.dir || "").trim();
    if (!dir) return sendJson(res, 400, { ok: false, error: "empty dir" });
    try {
      const out = setUploadDir(dir);
      inventory.invalidate();
      if (onEvent) onEvent({ type: "uploadDir", dir });
      return sendJson(res, 200, out);
    } catch (err) {
      noteError("setUploadDir", err);
      return sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
    }
  }

  function handleCacheDirGet(req, res, url) {
    const which = url.searchParams.get("which") || "root";
    const map = {
      root: DIRS.root, cache: DIRS.cache, thumbs: DIRS.thumbs, transcoded: DIRS.transcoded,
      uploads: getUploadDir(), diag: DIRS.diag, fonts: DIRS.fonts, avatars: DIRS.avatars, mascot: DIRS.mascot,
    };
    const dir = map[which] || DIRS.root;
    let entries = [];
    try {
      entries = readdirSync(dir).slice(0, 200).map((n) => {
        try {
          const st = statSync(join(dir, n));
          return { name: n, size: st.size, dir: st.isDirectory(), mtime: st.mtimeMs };
        } catch { return { name: n, size: 0, dir: false, mtime: 0 }; }
      });
    } catch { /* 目录不存在就当空 */ }
    sendJson(res, 200, { ok: true, dir, which, entries });
  }

  function handleDiagLog(req, res, url) {
    const limit = Math.min(500, Number(url.searchParams.get("limit") || 200));
    sendJson(res, 200, { ok: true, stats, errors: stats.errors.slice(-limit), inventory: inventory.stats });
  }

  function handleStatus(req, res) {
    const cfg = getConfig();
    sendJson(res, 200, {
      ok: true,
      port: actualPort,
      pid: process.pid,
      uptimeMs: Date.now() - stats.startedAt,
      dataRoot: DIRS.root,
      uploadDir: getUploadDir(),
      tokens: tokens.size(),
      inventory: inventory.stats,
      config: { id: cfg.id, cweEnabled: cfg.cweEnabled, cweUiAlpha: cfg.cweUiAlpha, cweUiAlphaMain: cfg.cweUiAlphaMain },
      stats: { requests: stats.requests, served: stats.served, servedBytes: stats.servedBytes, uploads: stats.uploads },
    });
  }

  // ---------------- 外观预设 ----------------
  // 预设是「一套观感」的快照：只能存颜色/透明度/模糊/特效这些外观键，
  // 不能存 cwePort、extraProjectDirs、hiddenIds 这类「这台机器的事实」。
  // 这个边界由 presets.mjs 的 presetKeys() 决定，这里只做 HTTP 形状。

  function handlePresetsGet(req, res) {
    sendJson(res, 200, {
      ok: true,
      presets: listPresets(),
      keys: presetKeys(),
      current: pickAppearance(getConfig()),
    });
  }

  async function handlePresetsPost(req, res, rest) {
    const body = await readBody(req, 256 * 1024);
    if (body === null) return sendJson(res, 413, { ok: false, error: "body too large" });
    let payload;
    try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }

    if (rest === "import") {
      const out = importPreset(payload.preset !== undefined ? payload.preset : payload, payload.name);
      if (!out.ok) return sendJson(res, 400, out);
      // 导入默认立刻应用：用户的意图就是「换成这套观感」。
      if (payload.apply !== false) {
        const next = updateConfig(out.applied);
        if (onEvent) onEvent({ type: "settings", patch: out.applied, config: next });
      }
      return sendJson(res, 200, { ok: true, preset: out.preset, applied: payload.apply !== false, ignoredKeys: out.ignoredKeys });
    }

    // 保存：values 省略时取当前配置的外观子集（「把现在这套存下来」）。
    const values = payload.values && typeof payload.values === "object" ? payload.values : pickAppearance(getConfig());
    const saved = savePreset({ id: payload.id, name: payload.name, values });
    sendJson(res, 200, { ok: true, preset: saved });
  }

  function handlePresetGet(req, res, id) {
    const p = getPreset(id);
    if (!p) return sendJson(res, 404, { ok: false, error: "no such preset" });
    sendJson(res, 200, { ok: true, preset: p });
  }

  function handlePresetExport(req, res, id) {
    const text = exportPreset(id);
    if (!text) return sendJson(res, 404, { ok: false, error: "no such preset" });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="cwe-preset-' + String(id).replace(/[^A-Za-z0-9_-]/g, "") + '.json"',
      "cache-control": "no-store",
    });
    res.end(text);
  }

  async function handlePresetApply(req, res, id) {
    const p = getPreset(id);
    if (!p) return sendJson(res, 404, { ok: false, error: "no such preset" });
    const next = updateConfig(p.values);
    inventory.invalidate();
    if (onEvent) onEvent({ type: "settings", patch: p.values, config: next });
    sendJson(res, 200, { ok: true, applied: p.values, config: next });
  }

  function handlePresetDelete(req, res, id) {
    const out = deletePreset(id);
    if (!out.ok) return sendJson(res, out.builtin ? 409 : 404, out);
    sendJson(res, 200, out);
  }

  /** 改名：POST /presets/<id>/rename {name} —— 只改显示名，id 与文件不动。 */
  async function handlePresetRename(req, res, id) {
    const body = await readBody(req, 256 * 1024);
    if (body === null) return sendJson(res, 413, { ok: false, error: "body too large" });
    let payload;
    try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
    const out = renamePreset(id, payload && payload.name);
    if (!out.ok) {
      const code = out.error === "builtin" ? 409 : out.error === "not-user-preset" ? 404 : 400;
      return sendJson(res, code, out);
    }
    sendJson(res, 200, out);
  }

  // ---------------- 调度 ----------------

  /** 注入层推送：POST /cwe/apply {patch?} —— 宿主把最新配置交给注入层。 */
  async function handleApply(req, res) {
    const body = await readBody(req, 256 * 1024);
    let patch = null;
    if (body && body.length) {
      try { patch = JSON.parse(body.toString("utf8")); } catch { patch = null; }
    }
    const cfg = patch && typeof patch === "object" ? updateConfig(patch) : getConfig();
    inventory.invalidate();
    if (onEvent) onEvent({ type: "apply", config: cfg });
    sendJson(res, 200, { ok: true, config: cfg });
  }

  const server = createServer((req, res) => {
    stats.requests++;
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      return sendText(res, 400, "bad url");
    }
    const pathname = url.pathname || "/";

    if (req.method === "OPTIONS") {
      setCors(res);
      res.writeHead(204);
      return res.end();
    }

    const path = pathname.startsWith(PREFIX + "/") ? pathname.slice(PREFIX.length + 1) : null;
    if (path === null) {
      if (pathname === "/" || pathname === PREFIX) {
        return sendJson(res, 200, {
          ok: true, name: "codex-wallpaper-engine", version: "0.4.2", prefix: PREFIX,
          routes: ["inventory", "media/<token>", "preview/<token>", "settings", "status", "diag-log", "upload", "upload-dir", "remove", "cache-dir", "apply", "mascot", "avatar/<side>", "fontsets/<op>/<id>", "system-fonts", "presets", "presets/<id>", "presets/<id>/export", "presets/<id>/apply", "presets/<id>/rename", "presets/import", "panel-open", "rotation-next"],
        });
      }
      return sendText(res, 404, "not found");
    }

    try {
      const m = /^([a-z-]+)(?:\/(.*))?$/.exec(path);
      const head = m ? m[1] : path;
      const rest = m && m[2] !== undefined ? m[2] : "";

      switch (head) {
        case "inventory": return handleInventory(req, res).catch((e) => { noteError("inventory", e); sendJson(res, 500, { ok: false, error: String(e && e.message || e) }); });
        case "media": return handleMedia(req, res, rest);
        case "preview": return handlePreview(req, res, rest);
        case "settings":
          if (req.method === "GET") return handleSettingsGet(req, res);
          if (req.method === "POST") return handleSettingsPost(req, res).catch((e) => { noteError("settings", e); sendJson(res, 500, { ok: false, error: "error" }); });
          if (req.method === "DELETE") return handleSettingsReset(req, res);
          return sendText(res, 405, "method not allowed");
        case "rotation-next": {
          // 页面在 trigger=videoEnd 时回调这一条（视频播完 → 换下一张）。
          // 只做转发：真正推进在 controller（它持有候选池与游标）。
          if (onEvent) onEvent({ type: "rotation-next" });
          sendJson(res, 200, { ok: true });
          return;
        }
        case "panel-open": {
          // 让页面把设置面板弹出来。MCP 工具与 CLI 都走这一条。
          if (onEvent) onEvent({ type: "panel-open" });
          sendJson(res, 200, { ok: true, panel: true });
          return;
        }
        case "apply": return handleApply(req, res).catch((e) => { noteError("apply", e); sendJson(res, 500, { ok: false, error: "error" }); });
        case "status": return handleStatus(req, res);
        case "diag-log": return handleDiagLog(req, res, url);
        case "upload": return handleUpload(req, res, url).catch((e) => { noteError("upload", e); sendJson(res, 500, { ok: false, error: "error" }); });
        case "remove": return handleRemove(req, res).catch((e) => { noteError("remove", e); sendJson(res, 500, { ok: false, error: "error" }); });
        case "upload-dir":
          if (req.method === "GET") return handleUploadDirGet(req, res);
          if (req.method === "POST") return handleUploadDirPost(req, res).catch((e) => { noteError("upload-dir", e); sendJson(res, 500, { ok: false, error: "error" }); });
          return sendText(res, 405, "method not allowed");
        case "cache-dir": return handleCacheDirGet(req, res, url);
        // ---- 用户资源面：吉祥物 / 头像 / 字体集 / 系统字体 ----
        // URL 不用 token：内容变了文件名就变（stamp），immutable 缓存才不会给旧图。
        case "presets": {
          // POST 只认两条路："" = 保存当前/给定值，import = 导入。
          // 曾经把 POST 一律丢给 handlePresetsPost，结果 POST /presets/<id>/apply 被当成「保存」
          // 凭空造出一个 p-xxxx 脏预设 —— 所以这里必须按 rest 精确分流。
          const sub = rest ? rest.split("/") : [];
          const isApply = sub.length === 2 && sub[1] === "apply";
          const isRename = sub.length === 2 && sub[1] === "rename";
          if (req.method === "POST") {
            if (isApply) return handlePresetApply(req, res, sub[0]).catch((e) => { noteError("preset apply", e); sendJson(res, 500, { ok: false, error: "error" }); });
            if (isRename) return handlePresetRename(req, res, sub[0]).catch((e) => { noteError("preset rename", e); sendJson(res, 500, { ok: false, error: "error" }); });
            if (!rest || rest === "import") return handlePresetsPost(req, res, rest).catch((e) => { noteError("presets", e); sendJson(res, 500, { ok: false, error: "error" }); });
          }
          if (req.method === "DELETE") return handlePresetDelete(req, res, sub[0]);
          if (!rest) return handlePresetsGet(req, res);
          if (sub.length === 2 && sub[1] === "export") return handlePresetExport(req, res, sub[0]);
          return handlePresetGet(req, res, sub[0]);
        }
        case "mascot": return faces.mascot(req, res, rest, url);
        case "avatar": return faces.avatar(req, res, rest, url);
        case "fontsets": return faces.fontsets(req, res, rest, url);
        case "system-fonts": return faces.systemFonts(req, res, rest, url);
        default:
          return sendText(res, 404, "not found: " + head);
      }
    } catch (err) {
      noteError("dispatch " + path, err);
      return sendText(res, 500, "internal error");
    }
  });

  let actualPort = port;

  /**
   * 监听。
   *
   * 老实现的坑：每试一次就 server.once("error", ...) 挂一个新监听，挂上去不摘。
   * 试到第 5 个端口时，前面 4 个错误处理器还活着；其中任何一个再被触发都会
   * reject 一个已经 settle 的 Promise（无效），但更糟的是它们都盯着同一个 server，
   * 一旦真出错会连着报好几次。EADDRINUSE 时的 +1 重试也有问题：它不区分
   * 「我的另一份在听」和「别的程序在听」，会一路盲试到 +12。
   *
   * 现在：一次只挂一个 handler，成功/失败都摘掉；端口 0 交给系统拿随机端口
   * （守护就是这么用的），固定端口被占就明确失败，让上层去挑一个真空闲的。
   */
  function listen(wantPort = port) {
    return new Promise((resolveP, rejectP) => {
      let settled = false;
      const cleanup = () => { server.removeListener("error", onError); };

      function onError(err) {
        if (settled) return;
        settled = true;
        cleanup();
        // 只清监听器，不去 close —— server 没 listen 成功时 close 会报 ERR_SERVER_NOT_RUNNING
        rejectP(err);
      }

      server.once("error", onError);
      server.listen(wantPort, host, () => {
        if (settled) return;
        settled = true;
        cleanup();
        actualPort = server.address().port;
        log("info", "host listening on http://" + host + ":" + actualPort);
        resolveP({ port: actualPort, url: "http://" + host + ":" + actualPort });
      });
    });
  }

  function close() {
    return new Promise((r) => server.close(() => r()));
  }

  return {
    server, listen, close,
    get port() { return actualPort; },
    get url() { return "http://" + host + ":" + actualPort; },
    inventory, tokens, stats,
    refresh() { inventory.invalidate(); },
  };
}
/**
 * src/host/routes-faces.mjs —— mascot / avatar / fontsets / system-fonts 四族路由。
 *
 * 拆成独立文件而不是塞进 server.mjs 的三个理由：
 *  1. server.mjs 已经 500+ 行、七个 routing 族，再塞四族会到读不动的地步；
 *  2. 这四族共享一套「上传字节 + 白名单键 + 服务端铸造文件名」的纪律，放一起才看得见；
 *  3. 它们跟壁纸清单无关，不参与 inventory 失效，边界天然干净。
 *
 * 契约：createFaceHandlers({log, onEvent}) → { mascot, avatar, fontsets, systemFonts }
 *   每个 handler 签名 (req, res, rest, url)，由 server.mjs 的 switch 直接调用。
 */
import { readFileSync } from "node:fs";
import { serveFile, sendJson, sendText, readBody } from "./media.mjs";
import {
  AVATAR_SIDES,
  IMAGE_MAX_BYTES,
  avatarCurrent,
  avatarRemove,
  avatarSet,
  extFromContentType,
  fontsetDelete,
  fontsetGet,
  fontsetList,
  fontsetPut,
  isFontSetId,
  mascotCurrent,
  mascotRemove,
  mascotSet,
  systemFonts,
} from "./faces.mjs";

export function createFaceHandlers({ log = () => {}, onEvent = null } = {}) {
  function notify(type, extra) {
    if (onEvent) onEvent({ type, ...extra });
  }

  /** 读图上传：四条判据（Content-Type 白名单 / 8MB 上限 / 非空 / 写盘成功）。 */
  async function receiveImage(req, res) {
    const ct = req.headers["content-type"];
    const ext = extFromContentType(ct);
    if (!ext) {
      sendJson(res, 415, { ok: false, error: "不支持的格式：" + String(ct || "unknown") + "（仅支持 JPG / PNG / WebP）" });
      return null;
    }
    const body = await readBody(req, IMAGE_MAX_BYTES);
    if (body === null) {
      sendJson(res, 413, { ok: false, error: "图片过大（上限 8MB）" });
      return null;
    }
    if (!body.length) {
      sendJson(res, 400, { ok: false, error: "empty body" });
      return null;
    }
    return { buf: body, ext };
  }

  // ---------------- 吉祥物：GET 取图 / POST 换图 / DELETE 清空 ----------------

  async function mascot(req, res) {
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        const cur = mascotCurrent();
        if (!cur) return sendJson(res, 404, { ok: false, error: "not-set" });
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        return serveFile(req, res, cur.abs, { cacheControl: "private, max-age=31536000, immutable" });
      }
      if (req.method === "POST") {
        const got = await receiveImage(req, res);
        if (!got) return;
        const out = mascotSet(got.buf, got.ext);
        notify("mascot", { name: out.name });
        return sendJson(res, 200, out);
      }
      if (req.method === "DELETE") {
        const out = mascotRemove();
        notify("mascot", { removed: out.removed });
        return sendJson(res, 200, out);
      }
      return sendText(res, 405, "method not allowed");
    } catch (err) {
      log("error", "mascot: " + (err && err.message || err));
      return sendJson(res, 500, { ok: false, error: "error" });
    }
  }

  // ---------------- 头像：/avatar/<user|ai> ----------------

  async function avatar(req, res, rest) {
    const side = String(rest || "").split("/")[0];
    if (!AVATAR_SIDES.includes(side)) return sendJson(res, 404, { ok: false, error: "bad side", sides: AVATAR_SIDES });
    try {
      if (req.method === "GET" || req.method === "HEAD") {
        const cur = avatarCurrent(side);
        if (!cur) return sendJson(res, 404, { ok: false, error: "not-set", side });
        return serveFile(req, res, cur.abs, { cacheControl: "private, max-age=31536000, immutable" });
      }
      if (req.method === "POST") {
        const got = await receiveImage(req, res);
        if (!got) return;
        const out = avatarSet(side, got.buf, got.ext);
        notify("avatar", { side, name: out.name });
        return sendJson(res, 200, out);
      }
      if (req.method === "DELETE") {
        const out = avatarRemove(side);
        notify("avatar", { side, removed: out.removed });
        return sendJson(res, 200, out);
      }
      return sendText(res, 405, "method not allowed");
    } catch (err) {
      log("error", "avatar: " + (err && err.message || err));
      return sendJson(res, 500, { ok: false, error: "error" });
    }
  }

  // ---------------- 字体集：list / get / put / delete / activate ----------------

  async function fontsets(req, res, rest, url) {
    const seg = String(rest || "").split("/").filter(Boolean);
    const op = seg[0] || "list";
    const id = seg[1] || "";
    try {
      if (op === "list" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, fontsets: fontsetList() });
      }
      if (op === "get" && req.method === "GET") {
        const found = fontsetGet(id);
        if (!found) return sendJson(res, 404, { ok: false, error: "not-found", id });
        return sendJson(res, 200, { ok: true, ...found });
      }
      if (op === "put" && req.method === "POST") {
        const body = await readBody(req, 512 * 1024);
        if (body === null) return sendJson(res, 413, { ok: false, error: "too large" });
        let doc;
        try { doc = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
        const out = fontsetPut(id || doc.id || "", doc);
        if (!out.ok) return sendJson(res, 400, out);
        notify("fontset", { id: out.id });
        return sendJson(res, 200, out);
      }
      if (op === "delete" && (req.method === "DELETE" || req.method === "POST")) {
        const out = fontsetDelete(id);
        if (!out.ok) return sendJson(res, out.error === "not-user-layer" ? 409 : 400, out);
        notify("fontset", { id, removed: true });
        return sendJson(res, 200, out);
      }
      if (op === "activate" && req.method === "POST") {
        // 激活只是往 config 里写 fontSetId —— 真正的字体应用在注入层做（它才看得见 CSS 变量）。
        if (!fontsetGet(id)) return sendJson(res, 404, { ok: false, error: "not-found", id });
        notify("fontset-activate", { id });
        return sendJson(res, 200, { ok: true, fontSetId: id });
      }
      if (op === "export" && req.method === "GET") {
        const found = fontsetGet(id);
        if (!found) return sendJson(res, 404, { ok: false, error: "not-found", id });
        return sendJson(res, 200, { ok: true, id, doc: found.doc });
      }
      if (op === "import" && req.method === "POST") {
        const body = await readBody(req, 512 * 1024);
        if (body === null) return sendJson(res, 413, { ok: false, error: "too large" });
        let doc;
        try { doc = JSON.parse(body.toString("utf8") || "{}"); } catch { return sendJson(res, 400, { ok: false, error: "bad json" }); }
        const newId = isFontSetId(doc.id) ? doc.id : ("imported-" + Date.now().toString(36));
        const out = fontsetPut(newId, doc);
        if (!out.ok) return sendJson(res, 400, out);
        notify("fontset", { id: newId, imported: true });
        return sendJson(res, 200, out);
      }
      return sendJson(res, 404, { ok: false, error: "unknown op", op });
    } catch (err) {
      log("error", "fontsets: " + (err && err.message || err));
      return sendJson(res, 500, { ok: false, error: "error" });
    }
  }

  // ---------------- 系统字体：TTL 缓存 + stale-while-revalidate ----------------

  async function systemFontList(req, res, rest, url) {
    if (req.method !== "GET") return sendText(res, 405, "method not allowed");
    const refresh = url.searchParams.get("refresh") === "1";
    try {
      return sendJson(res, 200, systemFonts({ refresh }), "no-store");
    } catch (err) {
      log("error", "system-fonts: " + (err && err.message || err));
      return sendJson(res, 200, { ok: false, fonts: [], source: "error", error: String(err && err.message || err) });
    }
  }

  return { mascot, avatar, fontsets, systemFonts: systemFontList };
}

/** 读一个字体集 JSON 原文（导出给注入层构造 @font-face 时用）。 */
export function readFontsetRaw(dir, id) {
  return readFileSync(dir + "/" + id + ".json", "utf8");
}

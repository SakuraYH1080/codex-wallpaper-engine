#!/usr/bin/env node
/**
 * codex-wallpaper-engine MCP server
 *
 * 职责：把宿主守护（bin/cwe.mjs start）暴露成模型可调用的工具。
 * 关键设计：
 *  - 进程内不持有壁纸状态，全部经 loopback HTTP 问宿主，宿主是唯一真源。
 *  - 每次工具调用前 ensureDaemon()：runtime.json 在且 /status 通就直接用，
 *    否则 detach 一个 bin/cwe.mjs start，最多等 15s。这样 Codex 重启后工具
 *    依然能用，不需要用户手动起守护。
 *  - 只用 node 内置模块，零依赖。
 */
import { createInterface } from "node:readline";
import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CWE_BIN = join(ROOT, "bin", "cwe.mjs");
const DATA_DIR = process.env.CWE_DATA_DIR || join(homedir(), ".codex-wallpaper-engine");
const RUNTIME_PATH = join(DATA_DIR, "runtime.json");
const PREFIX = "/wallpaper-engine";
const SERVER_VERSION = "0.4.2";

function readRuntime() {
  try {
    return JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function httpJson(url, opts = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 800) }; }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

let daemonStarting = null;
let nodeCmd = null;

/** 找不到 node 时按顺序试几个位置；缓存结果，避免每次工具调用都 spawn which。 */
function resolveNode() {
  if (nodeCmd) return nodeCmd;
  nodeCmd = process.env.CODEX_MCP_NODE_PATH || process.execPath;
  return nodeCmd;
}

async function probe(base) {
  try {
    const r = await httpJson(base + PREFIX + "/status", {}, 2500);
    return !!r.ok;
  } catch {
    return false;
  }
}

/** 确保宿主在跑。返回 {ok, base} —— 失败不抛，让工具层给模型一条人话。 */
async function ensureDaemon() {
  const rt = readRuntime();
  if (rt && rt.url && (await probe(rt.url))) return { ok: true, base: rt.url, started: false };

  if (!daemonStarting) {
    daemonStarting = (async () => {
      try {
        const child = spawn(resolveNode(), [CWE_BIN, "start"], {
          cwd: ROOT,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch {
        /* 起不来就让下面的轮询超时，把原因交给工具层 */
      }
      for (let i = 0; i < 75; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const cur = readRuntime();
        if (cur && cur.url && (await probe(cur.url))) return cur.url;
      }
      return null;
    })().finally(() => { daemonStarting = null; });
  }
  const url = await daemonStarting;
  if (url) return { ok: true, base: url, started: true };
  return { ok: false, base: null, started: true };
}

async function api(pathname, opts) {
  const d = await ensureDaemon();
  if (!d.ok) throw new Error("壁纸宿主起不来。先手动跑一次：node bin/cwe.mjs start，看 " + join(DATA_DIR, "cwe.log"));
  return httpJson(d.base + PREFIX + pathname, opts || {});
}

/** 宿主 base URL；runtime.json 缺失时给一条人话，而不是让上层拼出 "null/wallpaper-engine"。 */
function base0() {
  const rt = readRuntime();
  if (!rt || !rt.url) throw new Error("壁纸宿主还没起来。先跑一次：node bin/cwe.mjs start");
  return rt.url;
}

/** 让宿主把当前配置重推一次（换图/换字体之后，页面要立刻看见）。失败不致命。 */
async function refresh() {
  try {
    const rt = readRuntime();
    if (!rt || !rt.url) return;
    await httpJson(rt.url + PREFIX + "/apply", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 8000);
  } catch {
    /* 推不动就等下一次设置变更，不影响上传结果 */
  }
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 按扩展名定 Content-Type。服务端只认白名单，所以这里给不准会得到 415。 */
function mimeOfPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ""));
  const ext = m ? "." + m[1].toLowerCase() : "";
  const ct = MIME_BY_EXT[ext];
  if (!ct) throw new Error("只支持 png / jpg / webp / gif：" + p);
  return ct;
}

/** 读图并做尺寸上限检查（宿主侧还有 8MB 上限，这里提前给出更清楚的错误）。 */
function readImage(p) {
  if (!p) throw new Error("缺少 path");
  const st = statSync(p);
  if (!st.isFile()) throw new Error("不是一个文件：" + p);
  if (st.size > 8 * 1024 * 1024) throw new Error("图片超过 8MB 上限：" + p);
  return readFileSync(p);
}

function fmtWallpaper(w) {
  const bits = [w.type, w.id];
  if (w.title && w.title !== w.id) bits.push(w.title);
  return bits.join(" · ");
}

const TOOLS = [
  {
    name: "wallpaper_status",
    description:
      "查看壁纸引擎当前状态：宿主是否在跑、Codex 页面有没有挂上壁纸层、当前壁纸是哪一张、不透明度多少。排查问题先跑这个。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wallpaper_list",
    description:
      "列出壁纸库（本地上传的图片/视频）。返回 id、标题、类型、分级。可先按类型过滤。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["video", "image", "all"], description: "只看某一类，默认 all" },
        limit: { type: "number", description: "最多返回几条，默认 60" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_use",
    description:
      "把某张壁纸设为当前壁纸并立即生效。id 来自 wallpaper_list；也接受 next / prev / random 做相对切换。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "壁纸 id，或 next / prev / random" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_get",
    description: "读取壁纸引擎的当前配置。不带 key 返回全部；带 key 只返回那一项。",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "单个配置项名，如 wallpaperOpacity" } },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_set",
    description:
      "改一个或多个配置项，立刻生效并持久化。常用键：wallpaperOpacity(0-100 壁纸不透明度)、scrim(0-1 界面压暗)、backgroundBrightness/Contrast/Saturate、objectFit(cover/contain/fill)、layerScale、layerPositionX/Y、flip、switchTransition(cut/fade/slide/zoom/wipe)、cweUiAlpha/cweUiAlphaMain(0-1 Codex 界面不透明度)、sidebarGlass/sidebarBlur/sidebarAlpha、accent(强调色)、fxEnabled/fxClick/fxTrail、parallaxEnabled/parallaxBg、avatarEnabled/avatarSize、rotationEnabled/pictureSlideSeconds(自动轮换)。",
    inputSchema: {
      type: "object",
      properties: {
        values: {
          type: "object",
          description: "键值对，例如 {\"wallpaperOpacity\": 45, \"scrim\": 0.3}",
          additionalProperties: true,
        },
      },
      required: ["values"],
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_panel",
    description:
      "在 Codex 窗口里打开壁纸引擎设置面板（六个分页：壁纸 / 玻璃与界面 / 特效 / 视差 / 头像 / 宿主）。适合用户想自己调的时候。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wallpaper_upload",
    description:
      "把本机的一张图片或视频加进壁纸库并设为当前壁纸。支持 png/jpg/gif/webp/avif/mp4/webm，单文件上限 512MB。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "本机绝对路径" },
        title: { type: "string", description: "显示名，可省略" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_remove",
    description: "从壁纸库删掉一张上传的壁纸。",

    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_apply",
    description: "把当前配置重新推一次到页面。改完外部文件或页面刚刷过、壁纸层丢了时用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wallpaper_launch_codex",
    description:
      "带调试端口重启 Codex（壁纸注入需要它）。用户没开调试端口时，工具会连不上页面，此时用这个。会新开一个实例而不是杀掉现在的。",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "默认 9333" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_mascot",
    description:
      "吉祥物形象：查看当前有没有设、换一张图（png/jpg/webp，上限 8MB）、或清空。吉祥物挂在窗口右下角，可用 wallpaper_set 的 avatarEnabled / ropeShown / rosterScale 控制显示。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "set", "clear"], description: "默认 status" },
        path: { type: "string", description: "action=set 时的本机绝对路径" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_avatar",
    description:
      "对话头像：分别设置用户侧（user）和助手侧（ai）的小头像，png/jpg/webp，上限 8MB。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "set", "clear"], description: "默认 status" },
        side: { type: "string", enum: ["user", "ai"], description: "action=set / clear 时必填" },
        path: { type: "string", description: "action=set 时的本机绝对路径" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_fontset",
    description:
      "字体集：列出可用的字体集（随包内置 + 用户自定义）、查看某一套的字号/字族细节、启用某一套、或删掉自定义的那层。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "use", "delete"], description: "默认 list" },
        id: { type: "string", description: "字体集 id；get / use / delete 时必填" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_system_fonts",
    description: "列出本机已安装的字体族（取一次会缓存 10 分钟）。想知道字号字体能挑哪些时用。",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean", description: "强制重扫，忽略缓存" } },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_rotation",
    description:
      "轮播组：查看全部轮播列表 / 新建 / 改间隔与顺序与推进方式 / 增减成员 / 删除 / 启用或停用自动轮换。" +
      "trigger=videoEnd 表示「当前视频播完就换下一张」，interval 表示按固定分钟数换。" +
      "action=status 会把每组的成员数、当前生效组、下次切换时间都列出来。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "create", "update", "delete", "add", "remove", "use", "enable"],
          description: "默认 status。create 新建；update 改字段；add/remove 增减成员；use 切换当前生效组；enable 开关自动轮换",
        },
        id: { type: "string", description: "组 id；update / delete / add / remove / use 时必填" },
        name: { type: "string", description: "action=create / update 时的组名" },
        interval: { type: "number", description: "多少分钟换一张（1-1440），默认 30" },
        order: { type: "string", enum: ["sequence", "random"], description: "推进顺序" },
        trigger: { type: "string", enum: ["interval", "videoEnd"], description: "推进方式" },
        wallpaperId: { type: "string", description: "action=add / remove 时的壁纸 id" },
        enabled: { type: "boolean", description: "action=enable 时的目标状态" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "wallpaper_preset",
    description:
      "外观预设：把一整套观感（透明度 / 模糊 / 配色 / 特效 / 字体 / 吉祥物尺寸）存成命名快照，之后一键换回。" +
      "预设只含外观键 —— 端口、额外项目根、隐藏列表、轮播组不会被打包，换预设不会改到这些「这台机器的事实」。" +
      "随包三套：glass-dark（午夜玻璃）、clear-max（全通透）、plain（原生观感）。" +
      "action=save 存当前观感；apply 应用；list 看清单；export 拿 JSON；import 传入 JSON 落地；delete 删（随包的不给删）。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "save", "apply", "delete", "export", "import"],
          description: "默认 list",
        },
        id: { type: "string", description: "预设 id；apply / delete / export 时必填" },
        name: { type: "string", description: "action=save / import 时的名字" },
        preset: { type: "object", description: "action=import 时的预设对象（可含 name + values）" },
      },
      additionalProperties: false,
    },
  },
];

function text(s) {
  return { content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] };
}

async function callTool(name, args) {
  switch (name) {
    case "wallpaper_status": {
      const rt = readRuntime();
      const d = await ensureDaemon();
      if (!d.ok) return text({ daemon: "起不来", runtimePath: RUNTIME_PATH, log: join(DATA_DIR, "cwe.log") });
      const st = await httpJson(d.base + PREFIX + "/status", {}, 6000);
      return text({
        daemon: "running",
        host: d.base,
        cdpPort: rt && rt.cdpPort,
        startedNow: d.started,
        status: st.body,
        runtimePath: RUNTIME_PATH,
      });
    }
    case "wallpaper_list": {
      const r = await api("/inventory");
      const inv = r.body || {};
      const t = (args && args.type) || "all";
      const limit = Math.max(1, Math.min(500, (args && args.limit) || 60));
      const all = Array.isArray(inv.wallpapers) ? inv.wallpapers : [];
      const list = (t === "all" ? all : all.filter((w) => w.type === t)).slice(0, limit);
      return text({
        total: inv.total || 0,
        shown: list.length,
        current: (readRuntime() && null) || undefined,
        uploadDir: inv.uploadDir || null,
        wallpapers: list.map((w) => ({ id: w.id, title: w.title, type: w.type, source: w.source, contentrating: w.contentrating })),
      });
    }
    case "wallpaper_use": {
      const id = String((args && args.id) || "").trim();
      if (!id) throw new Error("缺少 id");
      let target = id;
      if (id === "next" || id === "prev" || id === "random") {
        const cfg = (await api("/settings")).body.config || {};
        const inv = (await api("/inventory")).body;
        const all = (inv.wallpapers || []).filter((w) => !(cfg.hiddenIds || []).includes(w.id));
        if (!all.length) throw new Error("壁纸库是空的，先 wallpaper_upload 传一张");
        const cur = all.findIndex((w) => w.id === cfg.id);
        if (id === "random") target = all[Math.floor(Math.random() * all.length)].id;
        else if (id === "next") target = all[(cur + 1 + all.length) % all.length].id;
        else target = all[(cur - 1 + all.length) % all.length].id;
      }
      const r = await api("/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: target }),
      });
      return text({ applied: target, ok: r.ok, config: r.body && r.body.config });
    }
    case "wallpaper_get": {
      const r = await api("/settings");
      const cfg = r.body.config || {};
      const key = args && args.key;
      if (key) {
        if (!(key in cfg)) throw new Error("没有这个配置项：" + key);
        return text({ [key]: cfg[key] });
      }
      return text(cfg);
    }
    case "wallpaper_set": {
      const values = (args && args.values) || {};
      if (!values || typeof values !== "object" || !Object.keys(values).length) throw new Error("values 不能为空");
      const r = await api("/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
      const cfg = r.body.config || {};
      const out = {};
      for (const k of Object.keys(values)) out[k] = cfg[k];
      return text({ ok: true, applied: out });
    }
    case "wallpaper_panel": {
      const r = await api("/apply", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      void r;
      const base = readRuntime();
      const open = await httpJson((base && base.url) + PREFIX + "/panel-open", { method: "POST" }, 5000).catch(() => null);
      return text({
        ok: true,
        hint: "面板已重新推送。若没看到，在 Codex 窗口按 ⌥⌘W（Windows 为 Alt+Ctrl+W）唤出。",
        extra: open && open.body,
      });
    }
    case "wallpaper_upload": {
      const { statSync } = await import("node:fs");
      const { basename } = await import("node:path");
      const p = String((args && args.path) || "");
      const st = statSync(p);
      if (!st.isFile()) throw new Error("不是一个文件：" + p);
      if (st.size > 512 * 1024 * 1024) throw new Error("文件超过 512MB");
      const name = encodeURIComponent(basename(p));
      const title = encodeURIComponent((args && args.title) || basename(p));
      const buf = readFileSync(p);
      const r = await api("/upload?name=" + name + "&title=" + title, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buf,
      }, 120000);
      if (!r.ok) throw new Error("上传失败：" + JSON.stringify(r.body).slice(0, 300));
      const id = r.body && r.body.id;
      if (id) {
        await api("/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
      }
      return text({ uploaded: r.body, nowActive: id });
    }
    case "wallpaper_remove": {
      const id = String((args && args.id) || "");
      if (!/^up-[a-z0-9-]+$/i.test(id)) throw new Error("只能删上传的壁纸（id 以 up- 开头）");
      const r = await api("/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      return text({ ok: r.ok, result: r.body });
    }
    case "wallpaper_apply": {
      const r = await api("/apply", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return text({ ok: r.ok, result: r.body });
    }
    case "wallpaper_launch_codex": {
      const port = Number((args && args.port) || 9333);
      const app = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
      const child = spawn(app, ["--remote-debugging-port=" + String(port)], { detached: true, stdio: "ignore" });
      child.unref();
      return text({ launched: app, port, note: "新实例已带调试端口启动；等 5-10 秒再跑 wallpaper_status。" });
    }
    case "wallpaper_mascot": {
      const action = String((args && args.action) || "status");
      const cur = await httpJson(readRuntime().url + PREFIX + "/mascot", { method: "HEAD" }, 5000).catch(() => null);
      if (action === "status") {
        return text({ set: !!(cur && cur.ok), url: (cur && cur.ok) ? readRuntime().url + PREFIX + "/mascot" : null });
      }
      if (action === "clear") {
        const r = await api("/mascot", { method: "DELETE" });
        await refresh();
        return text({ ok: r.ok, result: r.body });
      }
      const p = String((args && args.path) || "");
      const buf = readImage(p);
      const r = await api("/mascot", {
        method: "POST",
        headers: { "content-type": mimeOfPath(p) },
        body: buf,
      }, 30000);
      if (!r.ok) throw new Error("设置失败：" + JSON.stringify(r.body).slice(0, 300));
      await refresh();
      return text({ ok: true, mascot: r.body, url: readRuntime().url + PREFIX + "/mascot" });
    }
    case "wallpaper_avatar": {
      const action = String((args && args.action) || "status");
      if (action === "status") {
        const out = {};
        for (const side of ["user", "ai"]) {
          const h = await httpJson(readRuntime().url + PREFIX + "/avatar/" + side, { method: "HEAD" }, 5000).catch(() => null);
          out[side] = !!(h && h.ok);
        }
        return text(out);
      }
      const side = String((args && args.side) || "");
      if (side !== "user" && side !== "ai") throw new Error("side 只能是 user 或 ai");
      if (action === "clear") {
        const r = await api("/avatar/" + side, { method: "DELETE" });
        await refresh();
        return text({ ok: r.ok, result: r.body });
      }
      const p = String((args && args.path) || "");
      const buf = readImage(p);
      const r = await api("/avatar/" + side, {
        method: "POST",
        headers: { "content-type": mimeOfPath(p) },
        body: buf,
      }, 30000);
      if (!r.ok) throw new Error("设置失败：" + JSON.stringify(r.body).slice(0, 300));
      await refresh();
      return text({ ok: true, side, avatar: r.body });
    }
    case "wallpaper_fontset": {
      const action = String((args && args.action) || "list");
      const id = String((args && args.id) || "");
      if (action === "list") {
        const r = await api("/fontsets/list");
        return text(r.body);
      }
      if (!id) throw new Error("缺少 id");
      if (action === "get") {
        const r = await httpJson(base0() + PREFIX + "/fontsets/get/" + encodeURIComponent(id), {}, 6000);
        if (!r.ok) throw new Error("没有这套字体集：" + id);
        return text(r.body);
      }
      if (action === "use") {
        const s = await api("/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fontSetId: id }),
        });
        if (!s.ok) throw new Error("宿主拒绝：" + JSON.stringify(s.body).slice(0, 300));
        return text({ ok: true, fontSetId: s.body.config && s.body.config.fontSetId });
      }
      if (action === "delete") {
        const r = await httpJson(base0() + PREFIX + "/fontsets/delete/" + encodeURIComponent(id), { method: "DELETE" }, 8000);
        return text({ ok: r.ok, status: r.status, result: r.body });
      }
      throw new Error("未知 action：" + action);
    }
    case "wallpaper_system_fonts": {
      const q = args && args.refresh ? "?refresh=1" : "";
      const r = await httpJson(base0() + PREFIX + "/system-fonts" + q, {}, 20000);
      const b = r.body || {};
      const fonts = Array.isArray(b.fonts) ? b.fonts : [];
      return text({ source: b.source, count: fonts.length, fonts: fonts.slice(0, 300) });
    }
    case "wallpaper_rotation": {
      const action = String((args && args.action) || "status");
      const s0 = await api("/settings");
      const cfg = (s0.body && s0.body.config) || {};
      let groups = Array.isArray(cfg.rotationGroups) ? cfg.rotationGroups.map((g) => Object.assign({}, g)) : [];

      if (action === "status") {
        const inv = await api("/inventory");
        const invBody = inv.body || {};
        const byId = new Map((invBody.wallpapers || []).map((w) => [w.id, w]));
        return text({
          enabled: !!cfg.rotationEnabled,
          activeGroupId: cfg.rotationGroupId || null,
          defaultInterval: cfg.rotationInterval,
          groups: groups.map((g) => {
            const ids = Array.isArray(g.wallpaperIds) ? g.wallpaperIds : [];
            const missing = ids.filter((id) => !byId.has(id));
            return {
              id: g.id,
              name: g.name,
              interval: g.interval,
              order: g.order,
              trigger: g.trigger,
              members: ids.length,
              missing,
              active: g.id === cfg.rotationGroupId,
              sampleTitles: ids.slice(0, 5).map((id) => (byId.get(id) ? byId.get(id).title : id)),
            };
          }),
          inventoryTotal: invBody.total || 0,
        });
      }

      if (action === "create") {
        const g = {
          id: "grp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
          name: String((args && args.name) || "轮播列表 " + (groups.length + 1)),
          interval: Number((args && args.interval) || cfg.rotationInterval || 30),
          order: (args && args.order) === "random" ? "random" : "sequence",
          trigger: (args && args.trigger) === "videoEnd" ? "videoEnd" : "interval",
          wallpaperIds: Array.isArray(args && args.wallpaperIds) ? args.wallpaperIds.slice() : [],
        };
        groups.push(g);
        const r = await api("/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ rotationGroups: groups, rotationGroupId: g.id }),
        });
        if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
        return text({ ok: true, created: g, activeGroupId: g.id });
      }

      if (action === "use") {
        const id = String((args && args.id) || "");
        if (!groups.some((g) => g.id === id)) throw new Error("没有这一组：" + id);
        const r = await api("/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ rotationGroupId: id }),
        });
        if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
        return text({ ok: true, activeGroupId: id });
      }

      if (action === "enable") {
        const on = args && args.enabled !== undefined ? !!args.enabled : true;
        const r = await api("/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ rotationEnabled: on }),
        });
        if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
        return text({ ok: true, rotationEnabled: !!r.body.config.rotationEnabled, candidates: groups.length });
      }

      const id = String((args && args.id) || "");
      const at = groups.findIndex((g) => g.id === id);
      if (at < 0) throw new Error("没有这一组：" + id + "（先跑 action=status 看有哪些）");

      if (action === "delete") {
        groups.splice(at, 1);
        const nextActive = cfg.rotationGroupId === id ? (groups[0] ? groups[0].id : "") : undefined;
        const body = { rotationGroups: groups };
        if (nextActive !== undefined) body.rotationGroupId = nextActive;
        const r = await api("/settings", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
        return text({ ok: true, deleted: id, remaining: groups.length });
      }

      if (action === "update") {
        const g = groups[at];
        if (args.name !== undefined) g.name = String(args.name);
        if (args.interval !== undefined) g.interval = Number(args.interval);
        if (args.order !== undefined) g.order = args.order === "random" ? "random" : "sequence";
        if (args.trigger !== undefined) g.trigger = args.trigger === "videoEnd" ? "videoEnd" : "interval";
        const r = await api("/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ rotationGroups: groups }),
        });
        if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
        const after = (r.body.config.rotationGroups || []).find((x) => x.id === id) || g;
        return text({ ok: true, group: after });
      }

      if (action === "add" || action === "remove") {
        const wid = String((args && args.wallpaperId) || "");
        if (!wid) throw new Error("缺少 wallpaperId");
        const g = groups[at];
        const ids = Array.isArray(g.wallpaperIds) ? g.wallpaperIds.slice() : [];
        const cur = ids.indexOf(wid);
        if (action === "add") {
          if (cur < 0) ids.push(wid);
        } else if (cur >= 0) {
          ids.splice(cur, 1);
        }
        g.wallpaperIds = ids;
        const r = await api("/settings", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ rotationGroups: groups }),
        });
        if (!r.ok) throw new Error("宿主拒绝：" + JSON.stringify(r.body).slice(0, 300));
        return text({ ok: true, groupId: id, members: ids.length, changed: action === "add" ? cur < 0 : cur >= 0 });
      }

      throw new Error("未知 action：" + action);
    }
    case "wallpaper_preset": {
      const action = String((args && args.action) || "list");
      if (action === "list") {
        const r = await api("/presets");
        const list = (r.body && r.body.presets) || [];
        return text({
          count: list.length,
          current: (r.body && r.body.current) || null,
          // keys 是「这套预设存了几个外观键」的数字（presets.mjs 回的就是 number），
          // 曾经在这里又取一次 .length，结果永远报 0。
          presets: list.map((x) => ({ id: x.id, name: x.name, builtin: !!x.builtin, keys: Number(x.keys) || 0 })),
          hint: "action=apply id=... 应用；action=save name=... 存当前观感",
        });
      }
      if (action === "save") {
        const nm = String((args && args.name) || "").trim();
        const body = { name: nm || new Date().toLocaleString("zh-CN") };
        const r = await api("/presets", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("保存失败：" + JSON.stringify(r.body).slice(0, 300));
        // savePreset 回的是 {id,name,builtin,keys}，keys 是「存进去几个键」，不是 values。
        return text({ ok: true, saved: r.body.preset });
      }
      if (action === "apply") {
        const id = String((args && args.id) || "").trim();
        if (!id) throw new Error("action=apply 需要 id");
        const r = await api("/presets/" + encodeURIComponent(id) + "/apply", { method: "POST" });
        if (!r.ok) throw new Error("应用失败：" + JSON.stringify(r.body).slice(0, 300));
        await refresh();
        // applyPreset 回的是 {ok,applied:<values>,config}。
        return text({ ok: true, applied: id, changed: Object.keys((r.body && r.body.applied) || {}).length });
      }
      if (action === "delete") {
        const id = String((args && args.id) || "").trim();
        if (!id) throw new Error("action=delete 需要 id");
        const r = await api("/presets/" + encodeURIComponent(id), { method: "DELETE" });
        if (!r.ok) throw new Error((r.body && r.body.error) === "builtin" ? "随包预设删不掉，只能改它或另存" : "删除失败：" + JSON.stringify(r.body).slice(0, 300));
        return text({ ok: true, deleted: id });
      }
      if (action === "export") {
        const id = String((args && args.id) || "").trim();
        if (!id) throw new Error("action=export 需要 id");
        const r = await api("/presets/" + encodeURIComponent(id) + "/export");
        if (!r.ok) throw new Error("导出失败：" + JSON.stringify(r.body).slice(0, 300));
        return text(r.body);
      }
      if (action === "import") {
        const doc = (args && args.preset) || null;
        if (!doc || typeof doc !== "object") throw new Error("action=import 需要 preset 对象");
        // 默认名必须可区分：曾经一律叫「导入的预设」，真机上 16 个预设全同名，面板里分不出谁是谁。
        // 名字带本地时间戳（11-08 20:15），连续导入也能一眼看出先后。
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, "0");
        const stamp = p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
        const body = { preset: doc, name: String((args && args.name) || doc.name || ("观感 " + stamp)), apply: true };
        const r = await api("/presets/import", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error("导入失败：" + JSON.stringify(r.body).slice(0, 300));
        await refresh();
        return text({ ok: true, preset: r.body.preset, ignoredKeys: r.body.ignoredKeys || [] });
      }
      throw new Error("未知 action：" + action);
    }
    default:
      throw new Error("未知工具：" + name);
  }
}

// ---- JSON-RPC over stdio ----

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch { return; }
  const { id, method, params } = req;
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codex-wallpaper-engine", version: SERVER_VERSION },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") { if (!isNotification) send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const out = await callTool(name, args);
      send({ jsonrpc: "2.0", id, result: out });
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "出错：" + (e && e.message ? e.message : String(e)) }], isError: true },
      });
    }
    return;
  }
  if (method === "resources/list" || method === "prompts/list") {
    send({ jsonrpc: "2.0", id, result: { [method === "prompts/list" ? "prompts" : "resources"]: [] } });
    return;
  }
  if (!isNotification) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  }
});

process.stderr.write("[codex-wallpaper-engine] mcp server ready\\n");

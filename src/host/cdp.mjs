/**
 * 最小 CDP 客户端（零依赖，用 Node 内置 WebSocket）。
 * 只做本项目需要的四件事：连、选 target、evaluate、screenshot。
 */
import { setTimeout as sleep } from "node:timers/promises";

export const MAIN_URL = "app://-/index.html";

export function isMainUrl(url, match = MAIN_URL) {
  if (typeof url !== "string" || url.split(/[?#]/, 1)[0] !== match) return false;
  const initialRoute = new URL(url).searchParams.get("initialRoute");
  return !/^\/(?:avatar-overlay|detached-window)(?:[/?#]|$)/.test(initialRoute || "");
}

export function mainWindowExpression(match = MAIN_URL) {
  return "self === top && (" + isMainUrl.toString() + ")(location.href," + JSON.stringify(match) + ")";
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      const fns = this.listeners.get(msg.method) || [];
      fns.forEach((fn) => { try { fn(msg.params); } catch {} });
    });
    ws.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("cdp socket closed"));
      }
      this.pending.clear();
    });
  }

  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("cdp connect timeout")), 10000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("cdp connect failed")); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
    return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }
  off(method, fn) { const list = this.listeners.get(method) || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }

  /** 在页面里求值，返回序列化后的值。 */
  async eval(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      allowUnsafeEvalBlockedByCSP: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const text = d.exception?.description || d.text || "evaluate error";
      throw new Error(text);
    }
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

/**
 * 列出 target。默认只要 type==="page"（主窗口/副窗口）。
 *
 * all:true 时返回全部类型 —— 壁纸的 <iframe>（网页/场景渲染页）在 /json/list 里
 * 是一条独立的 iframe target，带自己的 webSocketDebuggerUrl。想直接读渲染页内部状态
 * 就得走它：跨源 iframe 在主窗口里拿不到 contentDocument，但在它自己的 target 里
 * 我们是页面本身，什么都不挡。
 */
export async function listPages(port, { all = false } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  const list = await res.json();
  return all ? list : list.filter((t) => t.type === "page");
}

/** 探测端口上是否有可用的 Electron 调试端点。 */
export async function probePort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const v = await res.json();
    return { ok: true, browser: v.Browser, wsUrl: v.webSocketDebuggerUrl };
  } catch {
    return null;
  }
}

/** 连接到主窗口 page target。主窗口路由可能带查询参数或 hash。 */
export async function connectMain(port, { match = MAIN_URL, timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let pages = [];
  for (;;) {
    try { pages = await listPages(port); } catch {}
    const hit = pages.filter((p) => isMainUrl(p.url, match));
    if (hit.length) {
      const cdp = await Cdp.attach(hit[0].webSocketDebuggerUrl);
      return { cdp, target: hit[0] };
    }
    if (Date.now() > deadline) {
      const urls = pages.map((p) => p.url.split(/[?#]/, 1)[0]).join(", ");
      throw new Error(`未找到主窗口 target "${match}"；当前 page: [${urls}]`);
    }
    await sleep(400);
  }
}

export { sleep };

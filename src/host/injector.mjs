/** 将最新配置同步到 Codex 主窗口的当前文档。 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAIN_URL, isMainUrl, mainWindowExpression, probePort, connectMain, listPages, sleep } from "./cdp.mjs";

const INJECT_DIR = fileURLToPath(new URL("../inject/", import.meta.url));

/**
 * 注入源码按需读取，不缓存成模块常量。
 *
 * 曾经的写法是在模块加载期 readFileSync 一次 —— 于是「改了 panel.js 却不生效」成了常客：
 * 守护进程早就起来了，源码还停在它启动那一刻。改成惰性读 + 按 mtime 缓存，
 * 改完盘只需 bump 两个脚本里的 VERSION（页面内幂等分支靠它），不必重启守护。
 */
const srcCache = new Map();
function readInject(name) {
  const p = INJECT_DIR + name;
  let st;
  try {
    st = statSync(p);
  } catch (e) {
    throw new Error("注入源码缺失：" + p);
  }
  const hit = srcCache.get(p);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.src;
  const src = readFileSync(p, "utf8");
  srcCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, src });
  return src;
}
export function runtimeExpression(payload) {
  return "(" + readInject("runtime.js") + ")(" + JSON.stringify(payload) + ")";
}

async function probeHost(url) {
  if (!document.body || document.readyState === "loading") return "waiting-for-document";
  const origin = new URL(url).origin;
  const listener = new AbortController();
  const violation = new Promise((resolve) => {
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "connect-src" &&
          (event.blockedURI === origin || event.blockedURI.startsWith(origin + "/"))) resolve("csp-blocked");
    }, { signal: listener.signal });
  });
  let timer;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    return response.ok ? "ready" : "host-unreachable";
  } catch {
    // CSP 事件在 fetch 拒绝后派送，等它一拍。端口、CORS 等错误不会触发重载。
    return await Promise.race([violation, new Promise((resolve) => {
      timer = setTimeout(() => resolve("host-unreachable"), 200);
    })]);
  } finally {
    listener.abort();
    clearTimeout(timer);
  }
}

export function createInjector({
  port = 9333,
  mainUrl = MAIN_URL,
  log = () => {},
  bypassCsp = true,
  allowReload = true,
  onState = null,
} = {}) {
  // 宿主使用固定的 Codex 主窗口 URL。测试传入独立的本机页面。
  const onMain = mainWindowExpression(mainUrl);
  const inMain = (expression) => "(" + onMain + ") ? (" + expression + ") : null";
  let session = null;
  let stopped = false;
  let connecting = null;
  let reconnectTimer = null;
  let connectionEpoch = 0;
  let lastPayload = null;
  let lastReason = "apply";
  let watchTimer = null;
  // 重载记账必须按「target + 文档」而不是只按 target：
  // 旧写法一个窗口只允许重载一次，第一次自救之后，新文档再遇同样问题也不再重载。
  const reloadAttempts = new Set();
  const reloadKey = (id, doc) => id + "#" + doc;
  const hasReloaded = (id) => {
    for (const k of reloadAttempts) if (k.startsWith(id + "#")) return true;
    return false;
  };

  const state = {
    port, connected: false, targetUrl: null, injected: false,
    cspBypassed: false, reloadedForCsp: false, visibilityForced: false,
    applyCount: 0, lastAppliedAt: 0, lastError: null,
    retryAttempt: 0, nextRetryIn: 0,
  };

  function pushState() {
    state.connected = !!session;
    state.injected = state.connected && !!state.lastAppliedAt;
    try { onState?.({ ...state }); } catch {}
  }

  function isCurrent(s, doc = s.doc) {
    return session === s && s.doc === doc && s.main;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      tryConnect();
    }, 600);
  }

  function tryConnect() {
    if (stopped || session) return;
    if (!connecting) {
      connecting = connectOnce(++connectionEpoch).catch((e) => {
        if (stopped) return;
        log("warn", "连不上主窗口: " + e.message);
        scheduleReconnect();
      }).finally(() => { connecting = null; });
    }
    return connecting;
  }

  async function connectOnce(epoch) {
    if (!await probePort(port)) {
      scheduleReconnect();
      return;
    }
    const { cdp, target } = await connectMain(port, { match: mainUrl, timeoutMs: 8000 });
    if (stopped || epoch !== connectionEpoch) {
      cdp.close();
      return;
    }
    const s = {
      cdp, target, doc: 0, main: true, readyDoc: null, reloadingDoc: null,
      appliedDoc: null, appliedPayload: null, panelSource: null, work: null,
      retryTimer: null, retryAttempt: 0, timeOrigin: null, videoDoc: null, reloadAt: 0,
    };
    session = s;
    state.targetUrl = mainUrl;
    state.lastAppliedAt = 0;
    state.lastError = null;
    state.visibilityForced = false;
    state.reloadedForCsp = hasReloaded(target.id);
    state.cspBypassed = false;

    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (session !== s || !frame || frame.parentId) return;
      clearRetry(s);
      s.doc++;
      s.main = isMainUrl(frame.url, mainUrl);
      s.panelSource = null;
      state.targetUrl = s.main ? mainUrl : null;
      state.lastAppliedAt = 0;
      state.lastError = null;
      state.visibilityForced = false;
      pushState();
      if (s.main) flush(s);
      else cdp.close();
    });
    cdp.on("Page.domContentEventFired", () => {
      if (!isCurrent(s) || s.readyDoc === s.doc || s.reloadingDoc === s.doc) return;
      clearRetry(s);
      s.appliedDoc = null;
      flush(s);
    });
    cdp.ws.addEventListener("close", () => {
      if (session !== s) return;
      clearRetry(s);
      session = null;
      state.targetUrl = null;
      state.lastAppliedAt = 0;
      pushState();
      scheduleReconnect();
    });

    try {
      await cdp.send("Page.enable", {}, 5000);
    } catch (e) {
      cdp.close();
      throw e;
    }
    if (session !== s) return;
    log("info", "已连上 Codex 主窗口");
    pushState();
    await flush(s);
  }

  async function prepareDocument(s, doc, base) {
    const { cdp, target } = s;
    if (s.reloadingDoc === doc) {
      // 重载若迟迟不带出新文档，说明这次 Page.reload 没生效（事件丢了或被拦）。
      // 一直返回 reloading 会让上层永远等下去 —— 超时后清标记，走正常探测。
      if (Date.now() - s.reloadAt < 10000) return "reloading";
      s.reloadingDoc = null;
      s.reloadAt = 0;
    }
    if (!base || !bypassCsp) {
      const ready = await cdp.eval(inMain("!!document.body && document.readyState !== 'loading'"), { timeoutMs: 5000 });
      return ready ? "ready" : "waiting-for-document";
    }

    const url = new URL("/wallpaper-engine/status", base);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return "invalid-host";
    const health = await cdp.eval(inMain("(" + probeHost.toString() + ")(" + JSON.stringify(url.href) + ")"), { timeoutMs: 12000 });
    if (!isCurrent(s, doc) || health !== "csp-blocked") return health || "waiting-for-document";
    if (!allowReload || reloadAttempts.has(reloadKey(target.id, doc))) return health;

    const tree = await cdp.send("Page.getFrameTree", {}, 5000);
    const frame = tree.frameTree?.frame;
    if (!isCurrent(s, doc) || !isMainUrl(frame?.url, mainUrl) || !frame.loaderId) return "waiting-for-document";

    await cdp.send("Page.setBypassCSP", { enabled: true }, 5000);
    if (!isCurrent(s, doc) || !lastPayload) return "waiting-for-document";
    state.cspBypassed = true;
    state.reloadedForCsp = true;
    reloadAttempts.add(reloadKey(target.id, doc));
    s.reloadingDoc = doc;
    s.reloadAt = Date.now();
    log("info", "当前文档的 CSP 拦截宿主，重新加载主窗口一次");
    try {
      await cdp.send("Page.reload", { ignoreCache: false, loaderId: frame.loaderId }, 10000);
    } catch (e) {
      s.reloadingDoc = null;
      throw e;
    }
    return "reloading";
  }

  async function ensureVideoActive(s, doc) {
    if (s.videoDoc === doc) return;
    s.videoDoc = doc;
    // 背景窗口的视频有时要等渲染器恢复 active 才交出首帧。
    try {
      await s.cdp.send("Page.setWebLifecycleState", { state: "active" }, 5000);
      if (!isCurrent(s, doc)) return;
      await s.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, 5000);
      if (isCurrent(s, doc)) state.visibilityForced = true;
    } catch (e) {
      log("warn", "视频可见性命令不可用: " + e.message);
    }
  }

  async function ensurePanel(s = session, doc = s?.doc) {
    if (!s || !isCurrent(s, doc)) return { ok: false };
    try {
      const src = readInject("panel.js");
      if (s.panelSource === src) return { ok: true, reused: true };
      const ready = await s.cdp.eval("if (" + onMain + ") {\n" + src + "\nBoolean(window.__CWE?.panel);\n}",
        { awaitPromise: false, timeoutMs: 10000 });
      if (!ready || !isCurrent(s, doc)) return { ok: false };
      s.panelSource = src;
      return { ok: true };
    } catch (e) {
      if (isCurrent(s, doc)) {
        state.lastError = "panel: " + e.message.slice(0, 300);
        log("warn", state.lastError);
      }
      return { ok: false };
    }
  }

  // 一条 CDP 会话上只跑一个同步循环。页面换文档时旧结果立即失效。
  function flush(s) {
    if (!s || !isCurrent(s) || !lastPayload) return Promise.resolve({ ok: false, reason: "not-ready" });
    if (!s.work) s.work = sync(s).finally(() => { s.work = null; });
    return s.work;
  }

  function clearRetry(s) {
    if (!s) return;
    clearTimeout(s.retryTimer);
    s.retryTimer = null;
    s.retryAttempt = 0;
    state.retryAttempt = 0;
    state.nextRetryIn = 0;
  }

  /**
   * 失败不再是一次性的终点。
   *
   * 旧实现在循环体第一行就把 appliedDoc 记成当前文档，于是 ready 失败走 continue 后
   * while 条件立刻不成立 —— 没有重试、没有第二次机会。再触发只靠
   * frameNavigated / domContentEventFired，而失败往往发生在文档加载完成之后，
   * 两个事件永不重现：页面只要在 Codex 启动那一刻抖一下，就永久停在 host-unreachable
   * （实测一次停摆 8 小时，直到手动 POST apply 才恢复）。
   *
   * 现在：成功才记账，失败按 0.8s → 1.6 → 3.2 → 6.4 → 12s 退避重试；
   * 另有 10s 看门狗兜底，任何一条路径把状态卡住都会被重新推一轮。
   */
  function scheduleRetry(s, doc, reason) {
    if (stopped || session !== s) return;
    if (s.retryTimer) return;
    const attempt = ++s.retryAttempt;
    const delay = Math.min(12000, 800 * Math.pow(2, Math.min(attempt - 1, 4)));
    state.retryAttempt = attempt;
    state.nextRetryIn = delay;
    if (attempt === 1 || attempt % 5 === 0) {
      log("info", "注入未完成(" + reason + ")，" + (delay / 1000).toFixed(1) + "s 后重试（第 " + attempt + " 次）");
    }
    s.retryTimer = setTimeout(() => {
      s.retryTimer = null;
      if (stopped || session !== s || s.doc !== doc) return;
      // 清掉记账，让 sync 重新走一整轮：探测文档 → 注入运行时 → 装面板。
      s.appliedDoc = null;
      s.readyDoc = null;
      s.panelSource = null;
      flush(s);
    }, delay);
  }

  // 看门狗：事件会丢，CDP 会话会静默；只要「当前文档该有壁纸却没有」就再推一轮。
  async function watchTick() {
    const s = session;
    if (stopped || !s || s.work || s.retryTimer) return;
    let origin = null;
    try {
      origin = await s.cdp.eval(inMain("performance.timeOrigin"), { timeoutMs: 3000 });
    } catch {
      return;
    }
    if (stopped || session !== s || !isCurrent(s)) return;
    if (typeof origin === "number" && origin > 0 && origin !== s.timeOrigin) {
      const first = s.timeOrigin === null;
      s.timeOrigin = origin;
      // 页面被重新加载过，但 frameNavigated 没到手：当成新文档重新来一遍。
      if (!first && s.appliedDoc !== null) {
        s.doc++;
        s.readyDoc = null;
        s.reloadingDoc = null;
        s.reloadAt = 0;
        s.panelSource = null;
        s.appliedDoc = null;
        s.videoDoc = null;
        log("info", "检测到主窗口已重新加载，重新注入");
      }
    }
    if (!lastPayload) return;
    // ★ 记账不等于事实。window.__CWE 被页面清掉（重载、Codex 自己换文档、SPA 换壳）时
    // appliedDoc / lastAppliedAt 仍然指着旧账，于是看门狗和 apply 都以为「已经是最新的」，
    // 再也不会推 —— 真机上表现为「宿主活着、CDP 通、页面却是裸的，怎么调都不生效」。
    // 所以每一轮都去页面里看一眼运行时到底还在不在。
    let alive = null;
    try {
      alive = await s.cdp.eval(inMain("!!(window.__CWE && window.__CWE.version)"), { timeoutMs: 3000 });
    } catch {
      return;
    }
    if (stopped || session !== s || !isCurrent(s)) return;
    if (alive !== true) {
      const wasApplied = s.appliedDoc !== null || !!state.lastAppliedAt;
      s.appliedDoc = null;
      s.readyDoc = null;
      s.panelSource = null;
      state.lastAppliedAt = 0;
      if (wasApplied) log("info", "主窗口里找不到运行时（页面被重载或清空过），重新注入一次");
    }
    if (s.appliedDoc !== s.doc || s.appliedPayload !== lastPayload || !state.lastAppliedAt) flush(s);
  }

  async function sync(s) {
    let out;
    while (isCurrent(s) && lastPayload && (s.appliedDoc !== s.doc || s.appliedPayload !== lastPayload)) {
      const doc = s.doc;
      const payload = lastPayload;
      try {
        if (s.readyDoc !== doc) {
          const ready = await prepareDocument(s, doc, payload.base);
          if (!isCurrent(s, doc)) continue;
          if (ready !== "ready") {
            out = { ok: false, reason: ready };
            state.lastError = ready === "reloading" || ready === "waiting-for-document" ? null : ready;
            if (state.lastError && s.retryAttempt === 0) log("warn", "主窗口暂未注入: " + ready);
            // reloading 交给重载后的 frameNavigated 接力；其余情况必须自己排重试。
            if (ready !== "reloading") scheduleRetry(s, doc, ready);
            pushState();
            return out;
          }
          s.readyDoc = doc;
        }
        if (payload.enabled !== false && payload.wallpaper?.kind === "video") await ensureVideoActive(s, doc);
        if (!isCurrent(s, doc) || payload !== lastPayload) continue;
        out = await s.cdp.eval(inMain(runtimeExpression(payload)), { timeoutMs: 12000 });
        if (!isCurrent(s, doc)) continue;
        if (!out?.ok) throw new Error(out?.error || "运行时未就绪");
        if (out.installed) s.panelSource = null;
        const panel = await ensurePanel(s, doc);
        if (!isCurrent(s, doc)) continue;
        if (!panel.ok) throw new Error("panel-not-ready");
        const now = Date.now();
        out = { ...out, ok: true, panel: panel.reused ? "reused" : "injected", at: now };
        state.applyCount++;
        state.lastAppliedAt = now;
        state.lastError = null;
        clearRetry(s);
        // 成功才记账 —— 这是整个自愈的前提。
        s.appliedDoc = doc;
        s.appliedPayload = payload;
      } catch (e) {
        if (!isCurrent(s, doc)) continue;
        state.lastError = String(e.message || e).slice(0, 400);
        out = { ok: false, error: state.lastError };
        if (s.retryAttempt === 0) log("warn", "注入失败(" + lastReason + "): " + state.lastError);
        scheduleRetry(s, doc, "inject");
        pushState();
        return out;
      }
      pushState();
    }
    return out || { ok: false, reason: "not-ready" };
  }

  function apply(payload, { reason = "apply" } = {}) {
    lastPayload = payload;
    lastReason = reason;
    const s = session;
    if (!s) return Promise.resolve({ ok: false, reason: "not-connected" });
    // 记账说「已经应用过」不等于页面里还有东西：Codex 自己重渲染、被 CSP 重载一次、
    // target 悄悄换了文档，都会让 DOM 变干净而 appliedDoc 还指着旧账。
    // 那样 flush 的 while 条件立刻不成立，apply 静默返回「无事可做」——
    // 真机上表现为「宿主活着、CDP 通、接口回 ok，但页面是裸的」。
    // 显式 apply 是人按按钮或接口触发，必须真的推一轮：先把账清成「页面是空的」。
    s.appliedDoc = null;
    s.readyDoc = null;
    s.panelSource = null;
    state.lastAppliedAt = 0;
    return flush(s);
  }

  async function uninstall() {
    lastPayload = null;
    const s = session;
    if (!s || !isCurrent(s)) return { ok: false };
    try {
      const out = await s.cdp.eval(inMain("window.__CWE?.unmount() || {ok:true,absent:true}"), { timeoutMs: 3000 });
      if (state.visibilityForced) {
        await s.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false }, 3000).catch(() => {});
        state.visibilityForced = false;
        s.videoDoc = null;
      }
      if (session === s) {
        s.panelSource = null;
        state.lastAppliedAt = 0;
        pushState();
      }
      return out;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function evaluate(expr, opts) {
    if (!session) throw new Error("未连接");
    return session.cdp.eval(expr, opts);
  }

  async function screenshot({ retries = 3 } = {}) {
    const cdp = session?.cdp;
    if (!cdp) throw new Error("未连接");
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
      try {
        const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 20000);
        if (r?.data) return Buffer.from(r.data, "base64");
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
    throw lastErr || new Error("screenshot empty");
  }

  async function pages() {
    try { return await listPages(port); } catch { return []; }
  }

  async function start() {
    stopped = false;
    if (!watchTimer) watchTimer = setInterval(() => { watchTick().catch(() => {}); }, 10000);
    await tryConnect();
    return { ...state };
  }

  async function stop() {
    stopped = true;
    connectionEpoch++;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearInterval(watchTimer);
    watchTimer = null;
    const s = session;
    clearRetry(s);
    await uninstall();
    session = null;
    s?.cdp.close();
    state.targetUrl = null;
    state.lastAppliedAt = 0;
    pushState();
  }

  return {
    start, stop, apply, uninstall, evaluate, screenshot, pages, ensurePanel,
    get state() { return { ...state }; },
    get connected() { return !!session; },
    get hasPayload() { return !!lastPayload; },
  };
}

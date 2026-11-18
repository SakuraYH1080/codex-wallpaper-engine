/**
 * codex-wallpaper-engine · 页面运行时（注入到 Codex 渲染进程里跑）
 *
 * 由宿主经 CDP Runtime.evaluate 注入，形如： (<本文件内容>)(payloadJson)
 * 壁纸与界面玻璃等到主壳和媒体到位后一起显示。
 * 宿主可多次 evaluate，同一文档内复用运行时。
 */
(function cweRuntime(payload) {
  "use strict";

  // 版本号是「换代码」的开关：页面里已有的运行时版本不同会先 unmount 再重建。
  // 改 runtime.js 之后必须一起改这里，否则幂等分支会让新代码永不生效。
  const VERSION = "0.8.4";
  const ROOT_ID = "cwe-root";
  const STYLE_ID = "cwe-style";
  const FX_ID = "cwe-fx";

  // 结构属性优先，CSS Module 的组件名前缀兼容较早的 Codex 构建。
  const frame = "#root :is([data-app-shell-frame],[class*='PageSurfaceLayout-'])";
  const leftSidebar = "#root aside:is([data-app-shell-left-panel-appearance],.app-shell-left-panel,[class*='LeftPanel-'])";
  const sidebarRail = "nav:is([data-app-navigation-rail],[class~='group/sidebar-rail'])";
  const sidebarList = "div:is([data-sidebar-navigation-root],.sidebar-navigation[class*='ConversationSidebar-'])";
  const peeking = "[data-slate-sidebar-peeking='true']";
  const dockedList = leftSidebar + ":not(" + peeking + ") " + sidebarList;
  const peekingList = leftSidebar + peeking + " " + sidebarList + " > [data-slate-sidebar-content]";
  const composer = "#root :is([data-composer-surface-variant],[class*='ComposerLayoutRoot-'])";
  const code = "#root div:is([class~='Root-iW7ipz'],[class*='Root-']:has(> [class*='ActionBar-']):has([data-code-block-source] > pre))";
  const elevated = ":is(.bg-surface-elevated,.bg-surface-elevated-secondary)";
  const command = ".command-menu-dialog :is([cmdk-root],[data-cmdk-root])";

  const surfaces = Object.freeze({
    frame,
    legacyShell: "#root > div > main.bg-surface",
    main: "#root :is([data-app-shell-main-surface],main[class*='MainContentSurface-'])",
    webview: "#root webview.bg-surface",
    titlebar: frame + " :is([data-app-shell-titlebar],header.h-toolbar), " +
      "#root:not(:has([data-app-shell-titlebar],header.h-toolbar)) div.h-toolbar[class*='fallbackDragRegion-']",
    leftSidebar,
    sidebarRail: leftSidebar + " " + sidebarRail,
    conversationSidebar: ":is(" + dockedList + "," + peekingList + ")",
    rightSidebar: frame + " [data-app-shell-focus-area='right-panel']",
    composer,
    composerBody: "#root :is([data-composer-body],[class*='ComposerLayoutBody-'])",
    composerChip: composer + " div.overflow-clip[class*='item-']",
    composerPill: composer + " div[class*='composer-layout-surface']",
    composerFooter: "#root div[class*='footer-']:has(:is([data-composer-body],[class*='ComposerLayoutBody-']))",
    code,
    codeHeader: code + " > div[class*='ActionBar-']",
    writing: "#root div.writing-block-surface",
    bubble: "#root div.bg-user-message",
    search: command,
    dialog: ":is(dialog[open],[role='dialog']):is([class*='Modal-'],.bg-surface-elevated,.bg-surface-elevated-secondary)" +
      ":not(.command-menu-dialog:has(:is([cmdk-root],[data-cmdk-root])),[class*='Popover-'])",
    menu: ":is([role='menu'],[role='listbox'])" + elevated +
      ", [data-radix-popper-content-wrapper] > div[class*='Popover-']",
    summary: "#root [class~='group/summary-panel']" + elevated,
  });

  // 两个命中都要在真实应用节点上。加载屏单独存在时，不启动背景样式。
  function hasAppShell() {
    const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible";
    return Array.from(document.querySelectorAll(surfaces.main)).some((main) => main.closest(surfaces.frame) && visible(main)) ||
      Array.from(document.querySelectorAll(surfaces.legacyShell + ":has(webview.bg-surface)")).some(visible);
  }

  function compatibilityReport() {
    const matches = {};
    for (const [name, selector] of Object.entries(surfaces)) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const visible = nodes.filter((node) => node.getClientRects().length > 0 &&
        getComputedStyle(node).visibility === "visible").length;
      matches[name] = { total: nodes.length, visible };
    }
    return {
      readyState: document.readyState,
      shellReady: hasAppShell(),
      backdropFilter: CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"),
      matches,
      runtimeVersion: window.__CWE?.version || null,
    };
  }

  if (payload?.compatProbe) return compatibilityReport();

  /* ═════════════ 幂等：已装过就只更新 ═════════════ */
  const existing = window.__CWE;
  if (existing && existing.version === VERSION && payload && !payload.forceReinstall) {
    try {
      existing.apply(payload);
      return { ok: true, reused: true, version: VERSION, state: existing.report() };
    } catch (e) {
      return { ok: false, reused: true, error: String((e && e.message) || e) };
    }
  }
  if (existing) {
    try { existing.unmount(); } catch (_) {}
  }

  /* ═════════════ 状态 ═════════════ */
  const state = {
    enabled: true,
    // 壁纸
    spec: null,            // {kind,url,mime,id}
    opacity: 100,
    blur: 0,
    scrim: 0.15,
    brightness: 100,
    contrast: 100,
    saturate: 100,
    fit: "cover",
    position: { x: 50, y: 50 },
    scale: 100,
    flip: false,
    playbackRate: 1,
    volume: 0,
    muted: true,
    transition: "cut",
    transitionDir: "left",
    transitionSpeed: "normal",
    slides: null,
    // 界面
    uiAlpha: 0.8,
    uiAlphaMain: 0.8,
    glass: null,
    // 特效 / 视差 / 吉祥物 / 字体
    fx: null,
    parallax: null,
    mascot: null,
    font: null,
    // 轮换状态（宿主推下来的，只读；页面据此决定要不要挂 video ended 回调）
    rotation: null,
    // 宿主地址（面板用它拼 API URL）
    base: "",
    mounted: false,
    appliedAt: 0,
  };

  const elCache = { root: null, scrim: null, slots: [], fx: null, style: null };
  let activeSlot = 0;
  let requestedWallpaper = null;
  let pendingMedia = null;
  let mediaError = null;
  let transitionTimer = null;
  let shellObserver = null;
  let appearanceActive = false;
  let slideTimer = null;
  let slideIndex = 0;
  let slideItems = null;

  const d = document;
  const reduceTransparency = matchMedia("(prefers-reduced-transparency: reduce)");
  const forcedColors = matchMedia("(forced-colors: active)");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /* ═════════════ 工具 ═════════════ */
  const px = (n, dflt) => (Number.isFinite(Number(n)) ? Number(n) : dflt);

  function mk(tag, id, css) {
    const e = d.createElement(tag);
    if (id) e.id = id;
    if (css) e.style.cssText = css;
    return e;
  }

  /* ═════════════ DOM 骨架 ═════════════
   * #cwe-root   fixed inset:0 z-index:0，垫在所有内容之下（插到 body 最前）
   *   ├─ .cwe-slot ×2   两层媒体槽，用于切换过渡
   *   └─ #cwe-scrim     压暗遮罩
   * #cwe-fx     fixed inset:0 z-index:55，画点击/拖尾特效（在内容之上，但不吃事件）
   */
  function ensureBody() {
    return d.body;
  }

  function ensureRoot() {
    const host = ensureBody();
    if (!host) throw new Error("no document root");
    let root = elCache.root && elCache.root.isConnected ? elCache.root : d.getElementById(ROOT_ID);
    if (!root) {
      root = mk("div", ROOT_ID, [
        "position:fixed", "inset:0", "z-index:0",
        "pointer-events:none", "overflow:hidden", "visibility:hidden",
        "contain:strict", "background:transparent",
        "transform:translateZ(0)",
      ].join(";"));
      root.setAttribute("aria-hidden", "true");
      host.insertBefore(root, host.firstChild);
    }
    elCache.root = root;

    elCache.slots = [];
    for (let i = 0; i < 2; i++) {
      let s = root.querySelector('.cwe-slot[data-i="' + i + '"]');
      if (!s) {
        s = mk("div", null, [
          "position:absolute", "inset:0",
          "opacity:0", "transform-origin:center center",
        ].join(";"));
        s.className = "cwe-slot";
        s.setAttribute("data-i", String(i));
        root.appendChild(s);
      }
      elCache.slots.push(s);
    }

    let scrim = root.querySelector("#cwe-scrim");
    if (!scrim) {
      scrim = mk("div", "cwe-scrim", "position:absolute;inset:0;z-index:2;pointer-events:none");
      root.appendChild(scrim);
    }
    elCache.scrim = scrim;
    state.mounted = true;
    return elCache;
  }

  function ensureStyle() {
    let style = elCache.style && elCache.style.isConnected ? elCache.style : d.getElementById(STYLE_ID);
    if (!style) {
      style = mk("style", STYLE_ID);
      (d.head || d.documentElement).appendChild(style);
    }
    elCache.style = style;
    return style;
  }

  /* ═════════════ 界面材质 ═════════════ */
  function themeCss() {
    const g = state.glass || {};
    const s = surfaces;
    const shell = ":is(" + s.frame + "," + s.legacyShell + ")";
    const a = Math.max(state.uiAlphaMain, state.uiAlpha);
    const am = state.uiAlphaMain;
    const over = am >= 1 ? 0 : (a - am) / (1 - am);
    const tint = (color, alpha) => "color-mix(in srgb, " + color + " " + (alpha * 100) + "%, transparent)";
    const base = "var(--cwe-surface)";
    const raised = "var(--cwe-elevated)";
    const out = [
      "html{--cwe-surface:var(--color-surface,#181818);--cwe-elevated:var(--color-surface-elevated-secondary,var(--cwe-surface));}",
      "html[data-theme='light']{--cwe-surface:var(--color-surface,#ffffff);}",
      "html.electron-opaque,html,body{background-color:transparent !important;}",
      shell + "{background-color:" + tint(base, am) + " !important;}",
      s.legacyShell + " :is(" + s.frame + "){background-color:transparent !important;}",
      ":is(" + s.main + "," + s.webview + "){background-color:" + tint(base, a) + " !important;}",
      shell + " :is(" + s.main + "," + s.webview + "){background-color:" + tint(base, over) + " !important;}",
    ];
    const solidFallbacks = [];
    const clear = "{background-color:transparent !important;background-image:none !important;}";
    const highlight = "inset 0 1px 0 color-mix(in srgb, currentColor 12%, transparent)";
    // brightness 可选：blur 必须永远排在第一位，saturate 在前会出色边（实测过）。
    // 深色玻璃靠它把壁纸的亮度往上抬一档，否则再低的 alpha 也只是一块发闷的暗板。
    const glass = (selector, color, blur, saturate, extra = "", brightness = 100) => {
      const backdrop = "blur(" + blur + "px) saturate(" + saturate + "%)" +
        (Number(brightness) === 100 ? "" : " brightness(" + brightness + "%)");
      out.push(selector + "{background-color:" + color + " !important;background-image:none !important;" +
        "backdrop-filter:" + backdrop + " !important;-webkit-backdrop-filter:" + backdrop + " !important;" + extra + "}");
      solidFallbacks.push(selector);
    };
    const whiteTint = (alpha, fallback) => "rgba(255,255,255," + px(alpha, fallback) / 100 + ")";
    const cardEdge = (radius) =>
      "border-radius:" + radius + "px !important;" +
      "box-shadow:0 8px 30px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.18) !important;";

    const sidebar = g.sidebar;
    const conversations = g.conversationSidebar;
    if (sidebar?.on) {
      const color = "rgba(" + (hexToRgb(sidebar.color) || "255,255,255") + "," + px(sidebar.alpha, 85) / 100 + ")";
      const blur = px(sidebar.blur, 8);
      const radius = px(sidebar.radius, 0);
      // 新布局的图标栏和会话列表各采样一次背景。旧布局仍由外层侧栏承载玻璃。
      const legacy = conversations ? s.leftSidebar + ":not(:has(" + sidebarRail + "," + sidebarList + "))" : s.leftSidebar;
      glass(legacy, color, blur, 140, radius ? "border-radius:" + radius + "px !important;" : "");
      if (conversations) {
        const railCorners = radius ? "border-start-start-radius:" + radius + "px !important;" +
          "border-end-start-radius:" + radius + "px !important;" : "";
        glass(s.sidebarRail, color, blur, 140, railCorners);
      }
      if (sidebar.edgeBlend) {
        const edge = conversations ? s.leftSidebar + ":not(:has(" + sidebarList + "))" : s.leftSidebar;
        glass(edge + "::after", color, blur, 140);
      } else {
        out.push(s.leftSidebar + "::after" + clear);
      }
      if (sidebar.contentColor && hexToRgb(sidebar.contentColor)) {
        out.push(s.leftSidebar + " *{color:rgb(" + hexToRgb(sidebar.contentColor) + ") !important;}");
      }
      if (sidebar.contentAlpha !== undefined && sidebar.contentAlpha !== 90) {
        const controls = s.leftSidebar + " :is(button,a,[role='button']):hover:not(:disabled,[aria-selected='true'],[aria-current])";
        out.push(controls + "{background-color:" + tint("currentColor", px(sidebar.contentAlpha, 90) * 0.0008) + " !important;}");
      }
    }

    if (conversations?.on) {
      // 会话列表（238px 窄栏）用的是「深冷墨 + 高饱和 + 微提亮」：
      // 旧写法永远拿 --cwe-surface(#181818) 混 alpha，结果是一块读不出壁纸的实心灰板，
      // 与右侧白 22% 的图标栏一亮一暗并排，接缝看着像贴了张纸。
      const tintColor = conversations.tint || "#0a0e14";
      const color = tint(tintColor, px(conversations.alpha, 32) / 100);
      const blur = px(conversations.blur, 16);
      const sat = px(conversations.saturate, 165);
      const bright = px(conversations.brightness, 112);
      glass(s.conversationSidebar, color, blur, sat, "", bright);
      // 光泽层：顶缘提亮 → 中段归零 → 底部压暗，给这块薄片一点厚度。
      // 必须写在 glass() 之后：它会强制 background-image:none !important，
      // 同选择器后写的这一条才是最终生效的那一层。
      out.push(s.conversationSidebar + "{background-image:linear-gradient(to bottom," +
        "rgba(255,255,255,.12) 0%,rgba(255,255,255,.035) 26%,rgba(255,255,255,.006) 50%,rgba(0,0,0,.11) 100%) !important;}");
      // 边缘：顶缘 1px 高光 + 右缘内 1px 亮线（玻璃厚度）+ 极淡整圈描边。
      // 深色玻璃的规矩是「减光」—— 边框用白不用黑，但要比浅色玻璃更淡。
      const edgeOn = conversations.edge !== false;
      out.push(dockedList + "{box-shadow:" + highlight +
        (edgeOn ? ",inset -1px 0 0 rgba(255,255,255,.15),inset 0 0 0 1px rgba(255,255,255,.06),inset 0 -16px 22px -14px rgba(0,0,0,.34)" : "") +
        ";}");
      const edge = s.leftSidebar + ":has(" + sidebarList + "):not(" + peeking + ")::after";
      if (sidebar?.edgeBlend) glass(edge, color, blur, sat, "", bright);
      else out.push(edge + clear);
    }

    if (g.titlebar?.on) {
      glass(s.titlebar, tint(base, px(g.titlebar.alpha, 86) / 100), px(g.titlebar.blur, 18), 125,
        "box-shadow:" + highlight + ";");
      out.push(s.main + " [class*='MainContentTopFade-']{background-image:none !important;}");
    }

    if (g.rightSidebar?.on) {
      glass(s.rightSidebar, tint(base, px(g.rightSidebar.alpha, 86) / 100), px(g.rightSidebar.blur, 20), 125,
        "--app-shell-panel-background:transparent;box-shadow:" + highlight + ";");
    }

    if (g.overlay?.on) {
      const color = tint(raised, px(g.overlay.alpha, 90) / 100);
      const blur = px(g.overlay.blur, 8);
      glass([s.menu, s.dialog, s.search, s.summary].join(","), color, blur, 125,
        "box-shadow:0 12px 36px rgba(0,0,0,.24)," + highlight + " !important;");
      out.push(".command-menu-dialog:has(:is([cmdk-root],[data-cmdk-root]))" + clear);
    }

    if (g.composer?.on) {
      const c = g.composer;
      const blur = px(c.blur, 28);
      const radius = px(c.radius, 22);
      glass(s.composerBody, whiteTint(c.alpha, 16), blur, 160,
        "border:1px solid rgba(255,255,255,.18) !important;" + cardEdge(radius));
      if (c.chipOn !== false) {
        glass(s.composerChip, whiteTint(c.chipAlpha, 12), blur, 160,
          "border:1px solid rgba(255,255,255,.14) !important;border-radius:" + radius + "px !important;");
      }
      if (c.pillOn !== false) {
        glass(s.composerPill, whiteTint(c.pillAlpha, 14), blur / 2, 140,
          "border:1px solid rgba(255,255,255,.14) !important;");
      }
      out.push(s.composer + "," +
        s.composerFooter + " div[class*='background-'][class*='surface-'].bg-surface," +
        s.composerFooter + " div[class*='background-'][class*='fade-']" + clear);
    }

    if (g.code?.on) {
      const c = g.code;
      glass(s.code, whiteTint(c.alpha, 10), px(c.blur, 26), 165,
        "border:1px solid rgba(255,255,255,.16) !important;" + cardEdge(px(c.radius, 18)));
      out.push(s.codeHeader + clear);
    }
    if (g.writing?.on) {
      glass(s.writing, whiteTint(g.writing.alpha, 9), px(g.writing.blur, 26), 165,
        "border:1px solid rgba(255,255,255,.16) !important;box-shadow:" + highlight + " !important;");
      out.push(s.writing + " > div.pointer-events-none," + s.writing + " header" + clear);
    }
    if (g.bubble?.on) {
      const color = "rgba(" + (hexToRgb(g.bubble.color) || "23,62,118") + "," + px(g.bubble.alpha, 34) / 100 + ")";
      glass(s.bubble, color, px(g.bubble.blur, 32), 170,
        "border:1px solid rgba(255,255,255,.20) !important;box-shadow:" + highlight + " !important;");
    }
    if (g.conversation?.color && hexToRgb(g.conversation.color)) {
      // Codex supplies the default text color in both themes.
      if (g.conversation.color.toLowerCase() !== "#ffffff") {
        out.push(s.main + "{color:rgb(" + hexToRgb(g.conversation.color) + ") !important;}");
      }
    }
    if (g.accent) out.push(":root{--cwe-accent:" + g.accent + ";}");
    if (solidFallbacks.length) {
      out.push("@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){" +
        solidFallbacks.join(",") + "{background-color:" + raised + " !important;}}");
    }
    if (g.extraSelectors) {
      for (const line of String(g.extraSelectors).split(/\r?\n/)) {
        const rule = line.trim();
        if (!rule || rule.startsWith("#") || !rule.includes("{")) continue;
        out.push(rule);
      }
    }

    out.push("#" + ROOT_ID + "{opacity:" + (px(state.opacity, 100) / 100) + ";" +
      "filter:brightness(" + px(state.brightness, 100) + "%) contrast(" + px(state.contrast, 100) + "%) " +
      "saturate(" + px(state.saturate, 100) + "%) blur(" + px(state.blur, 0) + "px);}");
    out.push("#" + ROOT_ID + " .cwe-slot > :is(img,video){width:100%;height:100%;object-fit:" +
      cssObjectFit() + ";object-position:" + px(state.position.x, 50) + "% " + px(state.position.y, 50) + "%;display:block;}");
    const fontPart = fontCss();
    if (fontPart) out.push(fontPart);

    return "@media not print {\n" + out.join("\n") + "\n}\n" +
      "@media print{#cwe-root,#cwe-fx,#cwe-mascot,#cwe-rope{display:none !important;}}";
  }

  function cssObjectFit() {
    const f = String(state.fit || "cover");
    if (f === "stretch") return "fill";
    if (f === "scale-down") return "scale-down";
    return f;
  }
  function hexToRgb(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16);
  }

  /* ═════════════ 媒体交接 ═════════════ */
  const TRANSITION_MS = { cut: 0, fade: 320, slide: 380, zoom: 380, wipe: 420 };
  const SPEED_SCALE = { fast: 0.65, normal: 1, slow: 1.6 };

  function sameMedia(a, b) {
    return a?.url === b?.url && a?.kind === b?.kind;
  }

  function resetSlot(slot) {
    slot.style.transition = "none";
    slot.style.opacity = "0";
    slot.style.transform = "";
    slot.style.clipPath = "";
    slot.style.zIndex = "0";
    const media = slot.firstElementChild;
    if (media?.tagName === "VIDEO") {
      media.pause();
      media.removeAttribute("src");
      media.load();
    } else if (media) {
      media.removeAttribute("src");
    }
    slot.replaceChildren();
  }

  function cancelPendingMedia() {
    if (!pendingMedia) return;
    const request = pendingMedia;
    pendingMedia = null;
    request.events.abort();
    clearTimeout(request.timer);
    resetSlot(request.slot);
  }

  function finishTransition() {
    if (!transitionTimer) return;
    clearTimeout(transitionTimer);
    transitionTimer = null;
    const active = elCache.slots[activeSlot];
    active.style.transition = "none";
    active.style.opacity = "1";
    active.style.clipPath = "";
    active.style.transform = "";
    resetSlot(elCache.slots[1 - activeSlot]);
  }

  function clearMedia() {
    cancelPendingMedia();
    finishTransition();
    for (const slot of elCache.slots) resetSlot(slot);
    state.spec = null;
    mediaError = null;
  }

  function syncVideoSettings() {
    const rot = state.rotation;
    const video = elCache.slots[activeSlot]?.querySelector("video");
    if (!video) return;
    video.loop = !(rot?.enabled && rot.trigger === "videoEnd");
    video.playbackRate = Math.min(4, Math.max(0.1, px(state.playbackRate, 1)));
    video.volume = Math.min(1, Math.max(0, px(state.volume, 0) / 100));
    video.muted = state.muted !== false || video.volume === 0;
  }

  function commitMedia(request) {
    if (pendingMedia !== request) return;
    pendingMedia = null;
    request.events.abort();
    clearTimeout(request.timer);

    const from = elCache.slots[activeSlot];
    const to = request.slot;
    const name = state.transition;
    const duration = (state.spec && appearanceActive && !reduceMotion.matches)
      ? Math.round((TRANSITION_MS[name] || 0) * (SPEED_SCALE[state.transitionSpeed] || 1))
      : 0;

    // 入场期间旧画面仍然完全覆盖底色，淡入时也不会露出黑底。
    from.querySelector("video")?.pause();
    from.style.zIndex = "0";
    to.style.zIndex = "1";
    if (duration) {
      const right = state.transitionDir === "right";
      if (name === "slide") to.style.transform = "translateX(" + (right ? 4 : -4) + "%)";
      if (name === "zoom") to.style.transform = "scale(1.06)";
      if (name === "wipe") to.style.clipPath = right ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)";
      void to.offsetWidth;
      to.style.transition = "opacity " + duration + "ms ease, transform " + duration + "ms ease, clip-path " + duration + "ms ease";
      to.style.transform = "";
      if (name === "wipe") to.style.clipPath = "inset(0)";
      transitionTimer = setTimeout(finishTransition, duration + 60);
    } else {
      resetSlot(from);
    }
    to.style.opacity = "1";
    activeSlot = request.index;
    state.spec = request.spec;
    syncVideoSettings();
    syncAppearance();
  }

  function swapMedia(spec) {
    if (!state.enabled || sameMedia(pendingMedia?.spec, spec)) return;
    cancelPendingMedia();
    mediaError = null;
    if (sameMedia(state.spec, spec)) return;
    finishTransition();

    const index = 1 - activeSlot;
    const slot = elCache.slots[index];
    const video = spec.kind === "video";
    const media = d.createElement(video ? "video" : "img");
    const events = new AbortController();
    const request = { spec, index, slot, events, timer: null };
    pendingMedia = request;
    const failed = (reason) => {
      if (pendingMedia !== request) return;
      cancelPendingMedia();
      mediaError = reason;
      syncAppearance();
    };
    request.timer = setTimeout(() => failed("load-timeout"), 20000);
    const listener = { once: true, signal: events.signal };
    media.addEventListener("error", () => failed("load-error"), listener);
    if (video) {
      media.preload = "auto";
      media.playsInline = true;
      media.muted = true;
      media.addEventListener("loadeddata", () => commitMedia(request), listener);
      media.addEventListener("ended", () => {
        const rot = state.rotation;
        if (pendingMedia || !state.enabled || rot?.trigger !== "videoEnd" || !rot.enabled ||
            elCache.slots[activeSlot]?.firstElementChild !== media) return;
        fetch(state.base + "/wallpaper-engine/rotation-next", { method: "POST" }).catch(() => {});
      });
    } else {
      media.alt = "";
      media.draggable = false;
    }
    slot.appendChild(media);
    if (video) {
      media.src = spec.url;
    } else {
      // ★ 图片不能用 decode() 收尾。
      //
      //   实测（Codex 157 / Electron，macOS）：<img>.decode() 对宿主 http 图片会一直挂起、
      //   永不 resolve —— 但同一个元素的 complete 立刻就是 true，load 事件也照常触发。
      //   旧实现只等 decode()，于是每张图都等满 20s 超时 → mediaError="load-timeout"
      //   → state.spec 永远 null → #cwe-root 停在 visibility:hidden。
      //   用户看到的就是「壁纸一片空白，状态写着加载失败，手动 apply 也救不回来」。
      //
      //   现在：load 事件是主路径；decode() 降级为「不影响结果的加速」（失败也不记账）；
      //   命中缓存时 src 赋值后同步就 complete，再补一次提交兜底。commitMedia 有自己的
      //   pendingMedia 守卫，多调一次是安全的。
      media.addEventListener("load", () => commitMedia(request), listener);
      media.src = spec.url;
      if (media.complete && media.naturalWidth > 0) {
        Promise.resolve().then(() => commitMedia(request));
      } else {
        media.decode().then(() => commitMedia(request), () => {});
      }
    }
  }

  /* ── slides：同一条目多图轮播 ── */
  function clearSlides() {
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
    slideItems = null; slideIndex = 0;
  }
  function startSlides(slides) {
    clearSlides();
    if (!slides || !Array.isArray(slides.items) || slides.items.length < 2) return;
    slideItems = slides;
    slideIndex = 0;
    const ms = Math.max(800, px(slides.intervalMs, 0));
    if (!ms) return;
    slideTimer = setInterval(() => {
      if (!slideItems || pendingMedia || !appearanceActive) return;
      slideIndex = (slideIndex + 1) % slideItems.items.length;
      const it = slideItems.items[slideIndex];
      const url = typeof it === "string" ? it : it.url;
      if (url) swapMedia({ kind: "image", url, id: "slide-" + slideIndex });
    }, ms);
  }

  /* ═════════════ 特效层（点击涟漪 + 鼠标拖尾） ═════════════ */
  const fx = {
    canvas: null,
    ctx: null,
    parts: [],
    trail: [],
    raf: 0,
    mouse: { x: 0, y: 0 },
    on: false,
    dpr: 1,
  };

  function accentColor() {
    const f = state.fx || {};
    if (f.colorMode === "custom" && f.color) return f.color;
    if (f.colorMode === "rainbow") return "hsl(" + ((Date.now() / 20) % 360) + ",90%,62%)";
    return (state.glass && state.glass.accent) || "#67DCE7";
  }

  function ensureFx() {
    let c = fx.canvas && fx.canvas.isConnected ? fx.canvas : d.getElementById(FX_ID);
    if (!c) {
      c = mk("canvas", FX_ID, [
        "position:fixed", "inset:0", "width:100%", "height:100%",
        "z-index:55", "pointer-events:none", "display:block",
      ].join(";"));
      ensureBody().appendChild(c);
    }
    fx.canvas = c;
    fx.ctx = c.getContext("2d");
    fx.dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(window.innerWidth * fx.dpr);
    c.height = Math.round(window.innerHeight * fx.dpr);
    if (state.fx) c.style.opacity = String(px(state.fx.opacity, 85) / 100);
    if (state.fx && state.fx.blend) c.style.mixBlendMode = state.fx.blend;
    return c;
  }

  function fxSpawnClick(x, y) {
    const f = state.fx || {};
    const style = (f.click && f.click.style) || "ripple";
    const size = px(f.click && f.click.size, 140);
    const glow = px(f.click && f.click.glow, 60) / 100;
    const color = accentColor();
    if (style === "burst") {
      const n = 18;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n;
        fx.parts.push({ t: "dot", x, y, vx: Math.cos(a) * (2 + Math.random() * 4), vy: Math.sin(a) * (2 + Math.random() * 4), r: 2 + Math.random() * 2, life: 1, color });
      }
    } else if (style === "ring") {
      fx.parts.push({ t: "ring", x, y, r: 6, vr: 3.2, life: 1, color, glow });
    } else if (style === "star") {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * 2 * i) / 6 + Math.random();
        fx.parts.push({ t: "star", x, y, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3, r: 3, life: 1, rot: Math.random() * 6, color });
      }
    } else {
      fx.parts.push({ t: "ripple", x, y, r: 4, vr: size / 26, max: size / 2, life: 1, color, glow });
    }
  }

  function fxTick() {
    const c = fx.canvas;
    const ctx = fx.ctx;
    if (!c || !ctx) { fx.raf = 0; return; }
    const w = c.width / fx.dpr, h = c.height / fx.dpr;
    ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const f = state.fx || {};

    // 拖尾
    if (f.trail && f.trail.on && fx.trail.length > 1) {
      const len = Math.min(fx.trail.length, px(f.trail.length, 420) / 6);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accentColor();
      ctx.lineWidth = px(f.trail.width, 3);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowBlur = px(f.trail.glow, 60) / 4;
      ctx.shadowColor = accentColor();
      for (let i = 1; i < len; i++) {
        const a = fx.trail[fx.trail.length - i];
        const b = fx.trail[fx.trail.length - i - 1];
        if (!a || !b) break;
        ctx.globalAlpha = (1 - i / len) * 0.85;
        if (f.trail.style === "dots") {
          ctx.beginPath();
          ctx.arc(b.x, b.y, px(f.trail.width, 3) * 0.8, 0, Math.PI * 2);
          ctx.fillStyle = accentColor();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    const maxTrail = Math.max(8, Math.round(px(f.trail && f.trail.length, 420) / 6));
    while (fx.trail.length > maxTrail) fx.trail.shift();

    // 粒子
    for (let i = fx.parts.length - 1; i >= 0; i--) {
      const p = fx.parts[i];
      if (p.t === "ripple") {
        p.r += p.vr; p.life -= 0.035;
        if (p.life <= 0 || p.r > p.max) { fx.parts.splice(i, 1); continue; }
        ctx.globalAlpha = p.life * 0.7;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2 + p.life * 2;
        ctx.shadowBlur = p.glow * 22;
        ctx.shadowColor = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (p.t === "ring") {
        p.r += p.vr; p.life -= 0.03;
        if (p.life <= 0) { fx.parts.splice(i, 1); continue; }
        ctx.globalAlpha = p.life * 0.9;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke();
      } else if (p.t === "dot") {
        p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= 0.02;
        if (p.life <= 0) { fx.parts.splice(i, 1); continue; }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill();
      } else if (p.t === "star") {
        p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.rot += 0.12; p.life -= 0.02;
        if (p.life <= 0) { fx.parts.splice(i, 1); continue; }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const a = (Math.PI * 2 * k) / 5 - Math.PI / 2;
          ctx.lineTo(Math.cos(a) * p.r * 1.6, Math.sin(a) * p.r * 1.6);
          const a2 = a + Math.PI / 5;
          ctx.lineTo(Math.cos(a2) * p.r * 0.7, Math.sin(a2) * p.r * 0.7);
        }
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    if (fx.parts.length || (f.trail && f.trail.on && fx.trail.length > 2)) {
      fx.raf = requestAnimationFrame(fxTick);
    } else {
      fx.raf = 0;
      ctx.clearRect(0, 0, w, h);
    }
  }

  function fxKick() {
    if (!fx.raf) fx.raf = requestAnimationFrame(fxTick);
  }

  let fxHandlers = null;
  function fxInstall() {
    const f = state.fx || {};
    if (!f.enabled) { fxUninstall(); return; }
    ensureFx();
    if (fxHandlers) return;
    fxHandlers = {
      click: (e) => { if (f.click && f.click.on) { fxSpawnClick(e.clientX, e.clientY); fxKick(); } },
      move: (e) => {
        fx.mouse.x = e.clientX; fx.mouse.y = e.clientY;
        if (f.trail && f.trail.on) {
          fx.trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
          const cap = Math.max(8, Math.round(px(f.trail.length, 420) / 6));
          while (fx.trail.length > cap) fx.trail.shift();
          fxKick();
        }
        if (state.parallax && state.parallax.enabled) parallaxMove(e.clientX, e.clientY);
      },
      resize: () => { if (fx.canvas && fx.canvas.isConnected) ensureFx(); },
    };
    window.addEventListener("pointerdown", fxHandlers.click, true);
    window.addEventListener("pointermove", fxHandlers.move, { passive: true });
    window.addEventListener("resize", fxHandlers.resize, { passive: true });
  }
  function fxUninstall() {
    if (fxHandlers) {
      window.removeEventListener("pointerdown", fxHandlers.click, true);
      window.removeEventListener("pointermove", fxHandlers.move);
      window.removeEventListener("resize", fxHandlers.resize);
      fxHandlers = null;
    }
    if (fx.raf) { cancelAnimationFrame(fx.raf); fx.raf = 0; }
    fx.parts.length = 0;
    fx.trail.length = 0;
    if (fx.canvas && fx.canvas.isConnected) fx.canvas.remove();
    fx.canvas = null; fx.ctx = null;
  }

  /* ═════════════ 视差 ═════════════ */
  let parallaxRaf = 0;
  let parallaxTarget = { x: 0, y: 0 };
  let parallaxCur = { x: 0, y: 0 };

  function parallaxMove(mx, my) {
    const p = state.parallax || {};
    const depth = px(p.bg, 1);
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    parallaxTarget.x = ((mx / w) - 0.5) * 2 * depth * 12;
    parallaxTarget.y = ((my / h) - 0.5) * 2 * depth * 12;
    if (!parallaxRaf) parallaxRaf = requestAnimationFrame(parallaxTick);
  }
  function parallaxTick() {
    const p = state.parallax || {};
    const smooth = Math.min(0.98, Math.max(0.02, px(p.smooth, 85) / 100));
    parallaxCur.x += (parallaxTarget.x - parallaxCur.x) * (1 - smooth * 0.9);
    parallaxCur.y += (parallaxTarget.y - parallaxCur.y) * (1 - smooth * 0.9);
    const root = elCache.root;
    if (root) root.style.transform = "translate3d(" + parallaxCur.x.toFixed(2) + "px," + parallaxCur.y.toFixed(2) + "px,0)";
    if (Math.abs(parallaxTarget.x - parallaxCur.x) > 0.05 || Math.abs(parallaxTarget.y - parallaxCur.y) > 0.05) {
      parallaxRaf = requestAnimationFrame(parallaxTick);
    } else { parallaxRaf = 0; }
  }
  function parallaxReset() {
    parallaxTarget = { x: 0, y: 0 };
    parallaxCur = { x: 0, y: 0 };
    if (elCache.root) elCache.root.style.transform = "";
    if (parallaxRaf) { cancelAnimationFrame(parallaxRaf); parallaxRaf = 0; }
  }

  /* ═════════════ 吉祥物 / 头像 ═════════════ */
  /**
   * 吉祥物分两层：
   *   rope   —— 从上方垂下来的绳子（一条贝塞尔 + 呼吸摆动），纯装饰；
   *   body   —— 绳子末端挂着的小家伙，有图用图，没图退化成玻璃方块。
   *
   * 两条纪律：
   *   1. 图片是宿主经 loopback 发的（faces 路由，文件名带 stamp），换图 = 换 URL，
   *      所以这里只比对 URL 字符串决定要不要重建 <img>，不做轮询。
   *   2. 整个吉祥物 pointer-events:none —— 它是装饰，不能挡住 Codex 的按钮。
   */
  let mascotEl = null;
  let mascotImg = null;
  let ropeEl = null;

  function mascotTeardown() {
    if (mascotEl && mascotEl.isConnected) mascotEl.remove();
    if (ropeEl && ropeEl.isConnected) ropeEl.remove();
    mascotEl = null;
    mascotImg = null;
    ropeEl = null;
  }

  function mascotApply(m) {
    state.mascot = m || null;
    const on = !!(m && (m.avatar || m.rope));
    if (!on) { mascotTeardown(); return; }

    if (!mascotEl || !mascotEl.isConnected) {
      mascotEl = mk("div", "cwe-mascot", [
        "position:fixed", "right:20px", "bottom:20px",
        "z-index:56", "pointer-events:none",
        "display:flex", "align-items:center", "justify-content:center",
        "overflow:hidden",
        "transition:transform 200ms ease, width 200ms ease, height 200ms ease",
      ].join(";"));
      ensureBody().appendChild(mascotEl);
    }

    const size = Math.max(12, px(m.size, 40));
    mascotEl.style.width = size + "px";
    mascotEl.style.height = size + "px";
    mascotEl.style.borderRadius = Math.max(0, Math.min(100, px(m.radius, 100))) + "%";

    const imgUrl = m.image || "";
    if (imgUrl) {
      if (!mascotImg || !mascotImg.isConnected || mascotImg.getAttribute("src") !== imgUrl) {
        mascotEl.textContent = "";
        mascotImg = mk("img", "", "width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;user-select:none");
        mascotImg.alt = "";
        mascotImg.draggable = false;
        mascotImg.setAttribute("src", imgUrl);
        // 图挂了就退化成玻璃方块，别留一个破图图标在右下角
        mascotImg.addEventListener("error", function () {
          try { mascotEl.style.background = "rgba(255,255,255,.06)"; } catch (_) {}
        });
        mascotEl.appendChild(mascotImg);
      }
      mascotEl.style.background = "transparent";
      mascotEl.style.border = "none";
      mascotEl.style.backdropFilter = "none";
    } else {
      if (mascotImg && mascotImg.isConnected) mascotImg.remove();
      mascotImg = null;
      mascotEl.textContent = "";
      mascotEl.style.background = "rgba(255,255,255,.06)";
      mascotEl.style.border = "1px solid rgba(255,255,255,.14)";
      mascotEl.style.backdropFilter = "blur(6px)";
    }

    // 绳子：从窗口顶边垂到吉祥物，一条二次贝塞尔 + 轻微摆动。
    // 用 SVG 而不是 canvas，因为它要跟着吉祥物的位置自动缩放，SVG 的 viewBox 免费给到。
    if (m.rope) {
      const sc = Math.max(0.1, Math.min(5, px(m.ropeScale, 1.15)));
      const form = m.ropeForm || "deepseek";
      if (!ropeEl || !ropeEl.isConnected) {
        ropeEl = d.createElementNS("http://www.w3.org/2000/svg", "svg");
        ropeEl.id = "cwe-rope";
        ropeEl.setAttribute("preserveAspectRatio", "none");
        ropeEl.style.cssText = "position:fixed;right:0;top:0;width:220px;height:calc(100vh - 20px);z-index:55;pointer-events:none;overflow:visible";
        ensureBody().appendChild(ropeEl);
      }
      const w = 220, h = Math.max(200, window.innerHeight - 20);
      ropeEl.setAttribute("viewBox", "0 0 " + w + " " + h);
      const anchorX = w - 20 - (size * sc) / 2;
      const endY = h - 20 - size * sc;
      // 控制点往左偏，做出「被风吹起来」的弧
      const d1 = "M " + anchorX + " 0 C " + (anchorX - 70) + " " + (endY * 0.42) + " " + (anchorX + 40) + " " + (endY * 0.74) + " " + anchorX + " " + endY;
      const stroke = form === "orb" ? "#8ab4ff" : form === "ghost" ? "#c9d6ff" : form === "cat" ? "#ffd08a" : "#67DCE7";
      ropeEl.innerHTML =
        '<path d="' + d1 + '" fill="none" stroke="' + stroke + '" stroke-opacity="0.55" stroke-width="' + (2.2 * sc).toFixed(2) + '" stroke-linecap="round"/>' +
        '<path d="' + d1 + '" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="' + (0.9 * sc).toFixed(2) + '" stroke-linecap="round"/>' +
        '<circle cx="' + anchorX + '" cy="' + endY + '" r="' + (3 * sc).toFixed(2) + '" fill="' + stroke + '" fill-opacity="0.8"/>';
      ropeEl.style.display = "";
      mascotEl.style.transform = "scale(" + sc.toFixed(3) + ")";
      mascotEl.style.transformOrigin = "center bottom";
    } else {
      if (ropeEl && ropeEl.isConnected) ropeEl.style.display = "none";
      mascotEl.style.transform = "";
    }
  }

  /* ═════════════ 字体 ═════════════ */
  /**
   * 字体分两层，和 settings-schema 里的语义一致：
   *   sizes / families 是「fontset 预设 + 用户在设置里的内联覆盖」合并后的结果；
   *   components 是按组件细分的覆盖（composer / sidebar / code）。
   *
   * 为什么用 CSS 而不是改 DOM：Codex 的界面是 React 渲染的，改 class 会被下一次
   * reconcile 抹掉；CSS 规则则一直有效。所以这里只产出一条 <style> 的内容，
   * 命中点全部限定在内容区里，避免把侧栏标题、顶栏按钮的字号一起改掉。
   */
  const FONT_UNIT_KEYS = ["markdown-h1", "markdown-h2", "markdown-h3", "markdown-small", "markdown-table", "markdown-table-head", "xs-13", "xxs-12"];

  function fontCss() {
    const f = state.font;
    if (!f || f.custom === false) return "";
    const sizes = f.sizes && typeof f.sizes === "object" ? f.sizes : {};
    const fams = f.families && typeof f.families === "object" ? f.families : {};
    const comps = f.components && typeof f.components === "object" ? f.components : {};
    const rules = [];
    const v = (n) => Number.isFinite(Number(n)) ? Number(n) : null;

    // 字体族：body 级更换最稳（Codex 大量用 font-sans 继承），
    // 代码块单独给，避免等宽字体被一起改掉。
    const bodyFam = fams["ui"] || fams["body"] || fams["base"] || null;
    if (bodyFam) rules.push("html body { font-family: " + JSON.stringify(bodyFam) + ", system-ui, sans-serif !important; }");
    if (fams["mono"] || fams["code"]) {
      const mono = fams["mono"] || fams["code"];
      rules.push("#root pre, #root code, #root textarea, #root [class*='font-mono'] { font-family: " + JSON.stringify(mono) + ", ui-monospace, monospace !important; }");
    }

    // 字号：只打内容区，命中 markdown 的真实标签
    const scope = "#root main[class*='MainContentSurface'], #root [class*='PageSurface']";
    const h1 = v(sizes["markdown-h1"]);
    const h2 = v(sizes["markdown-h2"]);
    const h3 = v(sizes["markdown-h3"]);
    const small = v(sizes["markdown-small"]);
    const table = v(sizes["markdown-table"]);
    const tableHead = v(sizes["markdown-table-head"]);
    if (h1) rules.push(scope + " h1 { font-size: " + h1 + "px !important; line-height: 1.3 !important; }");
    if (h2) rules.push(scope + " h2 { font-size: " + h2 + "px !important; line-height: 1.35 !important; }");
    if (h3) rules.push(scope + " h3 { font-size: " + h3 + "px !important; line-height: 1.4 !important; }");
    if (small) rules.push(scope + " small, " + scope + " [class*='text-xs'] { font-size: " + small + "px !important; }");
    if (table) rules.push(scope + " td { font-size: " + table + "px !important; }");
    if (tableHead) rules.push(scope + " th { font-size: " + tableHead + "px !important; }");

    // 组件级：只认白名单里的三个键，其余忽略 —— 任意选择器会把界面改坏
    const compSize = comps["composer"] && v(comps["composer"]);
    if (compSize) rules.push("#root [class*='ProseMirror'], #root [contenteditable='true'] { font-size: " + compSize + "px !important; }");
    const sideSize = comps["sidebar"] && v(comps["sidebar"]);
    if (sideSize) rules.push("#root aside[class*='app-shell-left-panel'] { font-size: " + sideSize + "px !important; }");
    const codeSize = comps["code"] && v(comps["code"]);
    if (codeSize) rules.push("#root pre, #root pre code { font-size: " + codeSize + "px !important; }");

    return rules.length ? "\n/* cwe font */\n" + rules.join("\n") : "";
  }

  function syncAppearance() {
    const shellReady = hasAppShell();
    if (state.enabled && !shellReady) {
      if (!shellObserver) {
        shellObserver = new MutationObserver(() => {
          if (hasAppShell()) syncAppearance();
        });
        shellObserver.observe(d.body, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["class", "style", "hidden", "data-app-shell-frame", "data-app-shell-main-surface"],
        });
      }
    } else if (shellObserver) {
      shellObserver.disconnect();
      shellObserver = null;
    }

    const hasBackdrop = !requestedWallpaper || !!state.spec || state.opacity === 0;
    appearanceActive = state.enabled && shellReady && hasBackdrop && !reduceTransparency.matches && !forcedColors.matches;
    const css = appearanceActive ? themeCss() : "";
    const style = appearanceActive ? ensureStyle() : elCache.style;
    if (style && style.textContent !== css) style.textContent = css;

    const root = elCache.root;
    root.style.visibility = appearanceActive && state.spec ? "visible" : "hidden";
    if (!appearanceActive || !state.parallax?.enabled || reduceMotion.matches) {
      parallaxReset();
      root.style.transform = "scale(" + px(state.scale, 100) / 100 + ")" + (state.flip ? " scaleX(-1)" : "");
    }
    if (appearanceActive && state.fx?.enabled && !reduceMotion.matches) fxInstall(); else fxUninstall();
    if (appearanceActive) mascotApply(state.mascot); else mascotTeardown();

    const video = elCache.slots[activeSlot]?.querySelector("video");
    if (video) {
      if (!appearanceActive) video.pause();
      else if (video.paused && !video.ended) video.play().catch(() => {});
    }
  }

  /* ═════════════ 主入口 ═════════════ */
  function apply(p) {
    if (!p) return state;
    state.appliedAt = Date.now();
    if (typeof p.base === "string" && p.base) state.base = p.base;
    if (p.enabled !== undefined) state.enabled = p.enabled !== false;

    const scalar = ["opacity", "blur", "scrim", "brightness", "contrast", "saturate",
      "fit", "scale", "flip", "playbackRate", "volume", "muted",
      "transition", "transitionDir", "transitionSpeed", "uiAlpha", "uiAlphaMain"];
    for (const key of scalar) {
      const value = p.wallpaper?.[key] ?? p[key];
      if (value !== undefined) state[key] = value;
    }
    if (p.wallpaper?.position) {
      state.position = { x: px(p.wallpaper.position.x, 50), y: px(p.wallpaper.position.y, 50) };
    }
    if (p.ui) {
      state.uiAlpha = p.ui.alpha ?? state.uiAlpha;
      state.uiAlphaMain = p.ui.alphaMain ?? state.uiAlphaMain;
      state.glass = p.ui.glass ?? state.glass;
    }
    for (const key of ["fx", "parallax", "mascot", "font", "rotation"]) {
      if (p[key] !== undefined) state[key] = p[key];
    }

    ensureRoot();
    let changed = false;
    if (p.wallpaper !== undefined) {
      const w = p.wallpaper;
      const next = w?.url ? { kind: w.kind || "image", url: w.url, mime: w.mime, id: w.id } : null;
      changed = !sameMedia(requestedWallpaper, next);
      requestedWallpaper = next;
      const slides = w?.slides || null;
      if (changed || JSON.stringify(slides) !== JSON.stringify(state.slides)) clearSlides();
      state.slides = slides;
    }
    if (!state.enabled || !requestedWallpaper) {
      clearSlides();
      clearMedia();
    } else {
      if (changed || (!pendingMedia && (!state.spec || mediaError))) swapMedia(requestedWallpaper);
      if (!slideTimer && state.slides) startSlides(state.slides);
    }

    elCache.scrim.style.background = "rgba(0,0,0," + px(state.scrim, 0) + ")";
    syncVideoSettings();
    syncAppearance();

    try { window.__CWE?.panel?.onHostApply?.(state); } catch {}
    return state;
  }

  function report() {
    const root = elCache.root || d.getElementById(ROOT_ID);
    return {
      version: VERSION,
      mounted: !!root,
      enabled: state.enabled,
      kind: state.spec && state.spec.kind,
      hasMedia: !!state.spec,
      mediaStatus: !state.enabled ? "disabled" : pendingMedia ? "loading" : mediaError ? "failed" : state.spec ? "ready" : "empty",
      mediaError,
      appearanceActive,
      url: state.spec ? String(state.spec.url).slice(0, 80) : null,
      opacity: state.opacity,
      uiAlpha: state.uiAlpha,
      uiAlphaMain: state.uiAlphaMain,
      rotation: state.rotation
      ? { enabled: !!state.rotation.enabled, trigger: state.rotation.trigger, candidates: state.rotation.candidates }
      : null,
    fxOn: !!(state.fx && state.fx.enabled),
      parallaxOn: !!(state.parallax && state.parallax.enabled),
      hasRoot: !!d.getElementById(ROOT_ID),
      slots: elCache.slots.length,
      hasFxCanvas: !!d.getElementById(FX_ID),
      base: state.base || "",
      panel: !!(window.__CWE && window.__CWE.panel),
      appliedAt: state.appliedAt,
    };
  }

  function unmount() {
    try { window.__CWE && window.__CWE.panel && window.__CWE.panel.destroy && window.__CWE.panel.destroy(); } catch (_) {}
    clearSlides();
    clearMedia();
    shellObserver?.disconnect();
    reduceTransparency.removeEventListener("change", syncAppearance);
    forcedColors.removeEventListener("change", syncAppearance);
    reduceMotion.removeEventListener("change", syncAppearance);
    fxUninstall();
    parallaxReset();
    mascotTeardown();
    d.getElementById(ROOT_ID)?.remove();
    d.getElementById(STYLE_ID)?.remove();
    d.getElementById(FX_ID)?.remove();
    delete window.__CWE;
    return { ok: true, uninstalled: true };
  }

  /* ═════════════ 导出 ═════════════ */
  window.__CWE = { version: VERSION, apply, report, unmount, state, swapMedia };

  try {
    apply(payload || {});
    reduceTransparency.addEventListener("change", syncAppearance);
    forcedColors.addEventListener("change", syncAppearance);
    reduceMotion.addEventListener("change", syncAppearance);
  } catch (e) {
    return { ok: false, error: String((e && e.stack) || (e && e.message) || e) };
  }
  return { ok: true, installed: true, version: VERSION, state: report() };
})

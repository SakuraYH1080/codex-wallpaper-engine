/**
 * src/host/controller.mjs —— 把「服务端状态」翻译成「页面 payload」，并驱动注入器
 *
 * 这一层是整套东西的中枢：
 *   config.json ──┐
 *   inventory ────┼─→ buildPayload() ─→ injector.apply() ─→ Codex 页面
 *   轮换计时 ─────┘
 *
 * 设计上的三条：
 *   1. payload 是纯数据，页面运行时不回读 config —— 状态只有一份，在宿主。
 *   2. 任何一次设置变更都重建整份 payload 再 apply（幂等，不做增量 diff，
 *      因为增量路径的分支数是设置项数量的平方，维护不了）。
 *   3. 壁纸选择（config.id）可能指向已删除的条目 —— 每次 build 都校验，失效就回落。
 */

import { getConfig, updateConfig } from "./config.mjs";
import { SETTINGS_VERSION } from "./settings-schema.mjs";
import { mascotCurrent, avatarCurrent, fontsetGet, mimeOfExt } from "./faces.mjs";

/** 轮换用的候选池：按当前过滤器过滤后的可用壁纸。 */
function pickPool(list, cfg) {
  // 只有上传来的两种：图片与视频。web / scene 两型随 Wallpaper Engine 连接一起删掉。
  const types = Array.isArray(cfg.typeFilter) && cfg.typeFilter.length ? cfg.typeFilter : ["video", "image"];
  const ratings = Array.isArray(cfg.contentRatingFilter) && cfg.contentRatingFilter.length
    ? cfg.contentRatingFilter
    : ["everyone", "pg13", "mature", "unrated"];
  const hidden = new Set(Array.isArray(cfg.hiddenIds) ? cfg.hiddenIds : []);
  return list.filter((w) => {
    if (!types.includes(w.type)) return false;
    if (w.contentrating && !ratings.includes(w.contentrating)) return false;
    if (hidden.has(w.id)) return false;
    return true;
  });
}

/**
 * 当前生效的轮播组（config.rotationGroupId 指向 rotationGroups 里的一项）。
 *
 * dsh 的组有两个字段决定行为：
 *   · order   —— sequence / random
 *   · trigger —— interval（计时）/ videoEnd（当前视频播完就换）
 * 这里都照搬。没有组时返回 null，调用方回落到「全部符合过滤的清单」。
 */
function activeRotationGroup(cfg) {
  const groups = Array.isArray(cfg.rotationGroups) ? cfg.rotationGroups : [];
  if (!groups.length) return null;
  return groups.find((g) => g && g.id === cfg.rotationGroupId) || null;
}

/**
 * 轮播候选池 —— 移植 dsh 的 groupWallpapers + isRotationEligible。
 *
 * 口径（与 dsh 逐条一致，别"顺手"加上 typeFilter）：
 *   · 只认组里列出的 id；
 *   · 必须可播放（playable !== false），hiddenIds 里的排除；
 *   · 内容分级过滤照旧生效；
 *   · **不认 typeFilter** —— dsh 原文：「类型档只筛选择器网格的显示（issue #294：
 *     切类型档不得改变轮播成员，也不得改变「下一张」的池）」。
 *     把 typeFilter 塞进来会让「换个 tab 就轮换不动了」这种怪事出现。
 */
function rotationCandidates(list, cfg) {
  const group = activeRotationGroup(cfg);
  if (!group) return [];
  const ratings = Array.isArray(cfg.contentRatingFilter) && cfg.contentRatingFilter.length
    ? cfg.contentRatingFilter
    : ["everyone", "pg13", "mature", "unrated"];
  const hidden = new Set(Array.isArray(cfg.hiddenIds) ? cfg.hiddenIds : []);
  const byId = new Map(list.map((w) => [w.id, w]));
  const out = [];
  const seen = new Set();
  for (const id of group.wallpaperIds || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const w = byId.get(id);
    if (!w) continue;
    if (w.playable === false) continue;
    if (hidden.has(w.id)) continue;
    if (w.contentrating && !ratings.includes(w.contentrating)) continue;
    out.push(w);
  }
  return out;
}

/** 把一条清单条目翻成页面能直接消费的媒体规格。 */
function specFor(w, base) {
  if (!w) return null;
  const abs = (u) => (u ? (u.startsWith("http") ? u : base + u) : null);
  if (w.type === "video") {
    return { id: w.id, title: w.title, kind: "video", url: abs(w.media), mime: w.mime || "video/mp4" };
  }
  if (w.type === "image") {
    return { id: w.id, title: w.title, kind: "image", url: abs(w.media || w.preview), mime: w.mime || "image/png" };
  }
  // 清单里只可能剩 image / video（见 inventory.mjs）；未知类型一律当空，别把坏数据推给页面
  return null;
}

/**
 * 吉祥物 / 头像载荷。
 *
 * 图片 URL 不用 token：faces.mjs 每次写入都换文件名（stamp + 随机后缀），
 * 文件名本身就是版本号，路由那边给的是 immutable 缓存 —— 换了图，URL 自然就变了。
 * 所以这里只需问「当前有没有图」，没有就发 null，页面那边据此回退到玻璃方块。
 */
function mascotPayload(cfg, base) {
  const abs = (u) => (u ? (u.startsWith("http") ? u : base + u) : null);
  const cur = mascotCurrent();
  const user = avatarCurrent("user");
  const ai = avatarCurrent("ai");
  const out = {
    avatar: !!cfg.avatarEnabled,
    size: cfg.avatarSize,
    radius: cfg.avatarRadius,
    rope: !!cfg.ropeShown,
    ropeForm: cfg.ropeForm,
    ropeScale: cfg.ropeScale,
    image: cur ? abs("/wallpaper-engine/mascot") : null,
    imageMime: cur ? mimeOfExt(cur.ext) : null,
    userImage: user ? abs("/wallpaper-engine/avatar/user") : null,
    aiImage: ai ? abs("/wallpaper-engine/avatar/ai") : null,
  };
  // 允许配置里「显式指定」某个文件名，用来防止缓存 —— 与 faces 的 stamp 同名时无副作用。
  if (cur && cfg.mascotImage && cfg.mascotImage !== cur.name) out.imageVersion = cfg.mascotImage;
  return out;
}

/**
 * 字体载荷。
 *
 * 只发「这份 fontset 的 values」，不发全部清单 —— 页面用不上清单，
 * 面板要清单自己去 /fontsets/list 拉。配置里的 themeSize / themeFamily 直接内联，
 * 这样 fontSetId 指向随包预设时也不用多走一次请求。
 */
function fontPayload(cfg) {
  const id = typeof cfg.fontSetId === "string" && cfg.fontSetId ? cfg.fontSetId : "";
  const hit = id ? fontsetGet(id) : null;
  const values = hit && hit.doc && hit.doc.values ? hit.doc.values : {};
  // DEFAULTS 里的两组是「用户直接在设置里微调」的覆盖层，优先级高于 fontset。
  const inlineSize = cfg.themeSize && typeof cfg.themeSize === "object" ? cfg.themeSize : {};
  const inlineFamily = cfg.themeFamily && typeof cfg.themeFamily === "object" ? cfg.themeFamily : {};
  return {
    setId: id || null,
    source: hit ? hit.source : null,
    name: hit && hit.doc && hit.doc.name ? hit.doc.name : null,
    sizes: Object.assign({}, values.themeSize || {}, inlineSize),
    families: Object.assign({}, values.themeFamily || {}, inlineFamily),
    weights: Object.assign({}, values.themeWeight || {}),
    components: Object.assign({}, values.componentFonts || {}),
    custom: cfg.fontCustom !== false,
    version: SETTINGS_VERSION,
  };
}

export function createController({ server, injector, log = () => {} }) {
  let rotationTimer = null;
  let pushRevision = 0;
  let lastPayload = null;
  let lastAppliedAt = 0;
  let nextRotationAt = 0;
  let rotationIndex = 0;

  async function currentInventory() {
    try {
      return await server.inventory.build();
    } catch (e) {
      log("warn", "清单构建失败: " + (e && e.message || e));
      return { wallpapers: [], total: 0 };
    }
  }

  /** 组装完整 payload。任何一次 UI 变更都走这里。 */
  async function buildPayload({ advance = false, revision = null } = {}) {
    const inv = await currentInventory();
    if (revision !== null && revision !== pushRevision) return null;
    const cfg = getConfig();
    const base = server.url || ("http://127.0.0.1:" + server.port);
    const list = Array.isArray(inv.wallpapers) ? inv.wallpapers : [];
    const byId = new Map(list.map((w) => [w.id, w]));

    const group = activeRotationGroup(cfg);
    const groupPool = rotationCandidates(list, cfg);

    let chosen = cfg.id ? byId.get(cfg.id) : null;
    let spec = chosen ? specFor(chosen, base) : null;

    // 轮换推进：组优先（dsh 口径），没组才退回「全部可播清单」。
    // 顺序推进用 rotationIndex 游标；随机推进直接掷一个不在当前 id 上的下标 ——
    // 纯随机会有「掷回自己」的空白一跳，用户看到的就是"到点了但没换"。
    if (advance && cfg.rotationEnabled) {
      const pool = groupPool.length >= 2 ? groupPool : pickPool(list, cfg);
      if (pool.length >= 2) {
        if (group && group.order === "random") {
          const others = pool.filter((w) => w.id !== cfg.id);
          const pick = others[Math.floor(Math.random() * others.length)] || pool[0];
          rotationIndex = Math.max(0, pool.findIndex((w) => w.id === pick.id));
          chosen = pick;
        } else {
          const cur = pool.findIndex((w) => cfg.id && w.id === cfg.id);
          rotationIndex = cur >= 0 ? (cur + 1) % pool.length : (rotationIndex + 1) % pool.length;
          chosen = pool[rotationIndex];
        }
        spec = chosen ? specFor(chosen, base) : spec;
        if (chosen && chosen.id !== cfg.id) updateConfig({ id: chosen.id });
      }
    }

    // id 失效 / 没选：按组或清单顺序兜底（不做 advance 推进，那一步在上面）
    if (!spec) {
      const pool = (groupPool.length ? groupPool : pickPool(list, cfg)).map((w) => specFor(w, base)).filter(Boolean);
      if (pool.length) {
        spec = pool[Math.min(rotationIndex, pool.length - 1)];
        if (!cfg.id && spec) updateConfig({ id: spec.id });
      }
    }

    // 静态图片轮换（slides）：只有条目本身带多张图时才生效
    let slides = null;
    if (chosen && Array.isArray(chosen.slides) && chosen.slides.length > 1 && chosen.slideIntervalMs > 0) {
      slides = { items: chosen.slides.map((s) => ({ url: (s.url || s).startsWith("http") ? (s.url || s) : base + (s.url || s) })), intervalMs: chosen.slideIntervalMs };
    }

    const payload = {
      version: 2,
      t: Date.now(),
      enabled: cfg.cweEnabled !== false,
      base,
      wallpaper: spec
        ? {
            ...spec,
            opacity: cfg.wallpaperOpacity,
            blur: cfg.wallpaperBlur,
            scrim: cfg.scrim,
            brightness: cfg.backgroundBrightness,
            contrast: cfg.backgroundContrast,
            saturate: cfg.backgroundSaturate,
            fit: cfg.objectFit,
            position: { x: cfg.layerPositionX, y: cfg.layerPositionY },
            scale: cfg.layerScale,
            flip: !!cfg.flip,
            playbackRate: cfg.playbackRate,
            volume: cfg.videoAudioEnabled ? cfg.videoVolume : 0,
            muted: !cfg.videoAudioEnabled,
            transition: cfg.switchTransition,
            transitionDir: cfg.switchTransitionDir,
            transitionSpeed: cfg.switchTransitionSpeed,
            slides,
          }
        : null,
      ui: {
        alpha: cfg.cweUiAlpha,
        alphaMain: cfg.cweUiAlphaMain,
        glass: {
          enabled: !!cfg.sidebarGlass || !!cfg.conversationSidebarGlass || !!cfg.titlebarGlass || !!cfg.rightSidebarGlass || !!cfg.overlayGlass ||
            !!cfg.composerGlass || !!cfg.codeGlass || !!cfg.writingGlass || !!cfg.bubbleGlass,
          sidebar: { on: !!cfg.sidebarGlass, blur: cfg.sidebarBlur, alpha: cfg.sidebarAlpha, color: cfg.sidebarColor, contentAlpha: cfg.sidebarContentAlpha, contentColor: cfg.sidebarContentColor, radius: cfg.leftSidebarCornerRadius, edgeBlend: !!cfg.sidebarEdgeBlend },
          conversationSidebar: {
            on: cfg.conversationSidebarGlass,
            alpha: cfg.conversationSidebarAlpha,
            blur: cfg.conversationSidebarBlur,
            tint: cfg.conversationSidebarTint,
            saturate: cfg.conversationSidebarSaturate,
            brightness: cfg.conversationSidebarBrightness,
            edge: !!cfg.conversationSidebarEdge,
          },
          titlebar: { on: !!cfg.titlebarGlass, alpha: cfg.titlebarTransparency, blur: cfg.titlebarBlur },
          rightSidebar: { on: !!cfg.rightSidebarGlass, alpha: cfg.rightSidebarTransparency, blur: cfg.rightSidebarBlur },
          overlay: { on: !!cfg.overlayGlass, alpha: cfg.floatersTransparency, blur: cfg.floatersBlur },
          composer: { on: !!cfg.composerGlass, alpha: cfg.composerAlpha, blur: cfg.composerBlur, radius: cfg.composerRadius, chipOn: !!cfg.composerChipGlass, chipAlpha: cfg.composerChipAlpha, pillOn: !!cfg.composerPillGlass, pillAlpha: cfg.composerPillAlpha },
          code: { on: !!cfg.codeGlass, alpha: cfg.codeAlpha, blur: cfg.codeBlur, radius: cfg.codeRadius },
          writing: { on: !!cfg.writingGlass, alpha: cfg.writingAlpha, blur: cfg.writingBlur },
          bubble: { on: !!cfg.bubbleGlass, alpha: cfg.bubbleAlpha, blur: cfg.bubbleBlur },
          conversation: { color: cfg.conversationColor },
          accent: cfg.accent,
          extraSelectors: cfg.extraGlassSelectors,
        },
      },
      fx: {
        enabled: !!cfg.fxEnabled,
        click: { on: !!cfg.fxClick, style: cfg.fxClickStyle, size: cfg.fxClickSize, glow: cfg.fxClickGlow },
        trail: { on: !!cfg.fxTrail, style: cfg.fxTrailStyle, length: cfg.fxTrailLength, width: cfg.fxTrailWidth, glow: cfg.fxTrailGlow },
        opacity: cfg.fxOpacity,
        blend: cfg.fxBlend,
        colorMode: cfg.fxColorMode,
        color: cfg.fxColor === "#4f8cff" ? cfg.accent : cfg.fxColor,
      },
      parallax: {
        enabled: !!cfg.parallaxEnabled,
        bg: cfg.parallaxBg,
        ui: !!cfg.parallaxUi,
        smooth: cfg.parallaxSmooth,
      },
      mascot: mascotPayload(cfg, base),
      font: fontPayload(cfg),
      // 轮换状态：页面据此知道「这张是组里第几张、一共有几张、下次什么时候换」。
      // trigger=videoEnd 时 nextAt 为 0，页面自己挂 video.ended 回调（见 runtime.js）。
      rotation: {
        enabled: !!cfg.rotationEnabled,
        groupId: group ? group.id : null,
        groupName: group ? group.name : null,
        order: group ? group.order : "sequence",
        trigger: group ? group.trigger : "interval",
        intervalMs: rotationDelayMs(cfg),
        nextAt: nextRotationAt || 0,
        index: rotationIndex,
        candidates: groupPool.length ? groupPool.length : pickPool(list, cfg).length,
        ids: (groupPool.length ? groupPool : pickPool(list, cfg)).map((w) => w.id),
      },
      diagnostics: { inventoryTotal: inv.total || 0 },
    };
    return payload;
  }

  async function push({ reason = "settings", advance = false } = {}) {
    const revision = ++pushRevision;
    const payload = await buildPayload({ advance, revision });
    if (!payload || revision !== pushRevision) return { ok: false, reason: "superseded" };
    lastPayload = payload;
    const out = await injector.apply(payload, { reason });
    if (revision === pushRevision) {
      if (out?.ok) lastAppliedAt = Date.now();
      scheduleRotation();
    }
    return out;
  }

  function clearRotation() {
    if (rotationTimer) { clearTimeout(rotationTimer); rotationTimer = null; }
    nextRotationAt = 0;
  }

  /**
   * 壁纸自动轮换的两个时间源（dsh 口径，别混用）：
   *   · rotationInterval —— 壁纸**之间**多久换一张，单位**分钟**，属于轮播组；
   *   · pictureSlideSeconds —— **一张图内部**幻灯片多久翻一张，单位秒。
   * dsh 只把 rotationInterval 用于壁纸轮换；pictureSlideSeconds 是图内过场
   * （原文见 lib/settings-schema.js:528-531「一个决定这张图里多久换一张，
   * 一个决定多久换一张壁纸」）。这里照此实现：
   *   · 有轮播组 ⇒ 用组的 interval（分钟），trigger=videoEnd 时**不计时**；
   *   · 没组 ⇒ 用 pictureSlideSeconds，兼容旧配置（它就是「全局轮换秒数」）。
   */
  function rotationDelayMs(cfg) {
    const group = activeRotationGroup(cfg);
    if (group) {
      if (group.trigger === "videoEnd") return 0; // 由页面在视频 ended 时回调，不计时
      return Math.max(60_000, (Number(group.interval) || 30) * 60_000);
    }
    const secs = Number(cfg.pictureSlideSeconds) || 0;
    return secs > 0 ? secs * 1000 : 0;
  }

  /** 壁纸自动轮换：由轮播组 interval（分钟）或 pictureSlideSeconds（秒）驱动。 */
  function scheduleRotation() {
    clearRotation();
    const cfg = getConfig();
    if (!cfg.rotationEnabled) return;
    const delay = rotationDelayMs(cfg);
    if (delay <= 0) return;
    nextRotationAt = Date.now() + delay;
    rotationTimer = setTimeout(async () => {
      rotationTimer = null;
      try {
        await push({ reason: "rotation", advance: true });
      } catch (e) {
        log("warn", "轮换失败: " + (e && e.message || e));
      }
    }, delay);
    if (rotationTimer.unref) rotationTimer.unref();
  }

  async function start() {
    // CDP 尚未连接时，注入器缓存这份初始配置。
    await push({ reason: "start" });
    return { ok: true, injected: injector.connected };
  }

  async function stop() {
    pushRevision++;
    clearRotation();
  }

  return {
    start,
    stop,
    push,
    buildPayload,
    get lastPayload() { return lastPayload; },
    get lastAppliedAt() { return lastAppliedAt; },
    get nextRotationAt() { return nextRotationAt; },
    get rotationIndex() { return rotationIndex; },
  };
}

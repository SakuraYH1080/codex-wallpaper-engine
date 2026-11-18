/**
 * 设置 schema —— 直接照搬 dsh-wallpaper-engine 的 config.json 字段面（settingsVersion 8），
 * 所以用户从 dsh 迁过来时，配置能一对一落位，不用重新调一遍。
 *
 * 三段：DEFAULTS（默认值）/ GROUPS（面板分组与控件）/ sanitize（落盘前的清洗）
 */

export const SETTINGS_VERSION = 8;

export const DEFAULTS = {
  // ---- 壁纸与播放 ----
  id: "",
  wallpaperOpacity: 100,
  wallpaperBlur: 0,
  backgroundBrightness: 100,
  backgroundContrast: 104,
  backgroundSaturate: 108,
  scrim: 0,
  border: 0.75,
  blur: 2,
  switchTransition: "cut",
  switchTransitionDir: "left",
  switchTransitionSpeed: "normal",
  rotationEnabled: false,
  pictureSlideSeconds: 0,
  rotationGroupId: "",
  rotationGroups: [],
  rotationSeeded: true,
  // 轮播组的默认间隔（分钟）。dsh 的 DEFAULTS.rotationInterval = 30；
  // 注意它与 pictureSlideSeconds（秒，全局兜底间隔）是两件事：
  // 组有 interval 时以组为准，没有组时用 pictureSlideSeconds。
  rotationInterval: 30,
  hiddenIds: [],
  playbackRate: 1,
  videoVolume: 0,
  videoAudioEnabled: true,
  flip: false,
  objectFit: "cover",
  layerPositionX: 50,
  layerPositionY: 50,
  layerScale: 100,
  typeFilter: ["video", "image"],
  contentRatingFilter: ["everyone", "pg13", "mature", "unrated"],

  // ---- 玻璃外观 ----
  accent: "#67DCE7",
  extraGlassSelectors: "",
  settingsWindowTransparency: 74,
  settingsWindowBlur: 18,
  conversationColor: "#ffffff",
  floatersTransparency: 90,
  floatersBlur: 8,
  leftSidebarCornerRadius: "20",
  rightSidebarTransparency: 84,
  rightSidebarBlur: 20,
  titlebarGlass: true,
  titlebarTransparency: 86,
  titlebarBlur: 18,
  rightSidebarGlass: true,
  overlayGlass: true,
  sidebarGlass: true,
  // 窄条（238px）上的模糊超过 ~16px 就会把壁纸平均成一片均匀灰板，
  // 透明度再低也救不回来 —— 所以默认取 14，配合 22% 白雾即可透出壁纸。
  sidebarBlur: 14,
  sidebarAlpha: 22,
  conversationSidebarGlass: true,
  // 会话列表（238px）要的是「深冷墨薄片」而不是「灰板」：
  // 底色用深冷墨（不是 --cwe-surface 的中性灰）→ 透进来的壁纸彩度不变脏；
  // alpha 降到 32 让壁纸真的透出来；saturate 抬到 165 把壁纸的颜色带上来；
  // brightness 112 把被 blur 平均掉的暗部提亮一档，否则窄栏会闷。
  // 这三项都是「同一块玻璃的成因」，别只调 alpha —— 单独降 alpha 只会更糊更灰。
  conversationSidebarAlpha: 32,
  conversationSidebarBlur: 16,
  conversationSidebarTint: "#0a0e14",
  conversationSidebarSaturate: 165,
  conversationSidebarBrightness: 112,
  conversationSidebarEdge: true,
  sidebarColor: "#ffffff",
  sidebarContentAlpha: 90,
  sidebarContentColor: "",
  // 侧栏与主界面之间那条 20px 的接缝：Codex 原生用 ::after + background:inherit 画，
  // 但它没有 backdrop-filter，于是那条竖带盖在未模糊的壁纸上，看起来比侧栏更亮更实。
  // false = 直接抹掉（默认，视觉最干净）；true = 给它补上侧栏同款背景 + 模糊。
  sidebarEdgeBlend: false,
  // ---- 输入框（composer）液态玻璃 ----
  // 实测要分两层：ComposerLayoutBody（输入区）+ item-* 那行 chip（选择项目/此计算机）。
  // 只改前者会在玻璃面板顶上留一条深灰实心块。
  composerGlass: true,
  composerAlpha: 16,
  composerBlur: 28,
  composerRadius: 22,
  composerChipGlass: true,
  composerChipAlpha: 12,
  // 输入框右下角那颗「模型 / 权限」胶囊：原生用 CSS 变量
  // --composer-layout-surface-background 画成 rgb(54,54,54) 实色，
  // 玻璃化输入框后它会变成玻璃面板上的一块深灰补丁，所以单独给一组键。
  composerPillGlass: true,
  composerPillAlpha: 14,

  // ---- 代码块（GPT 回复里的 CodeBlock）液态玻璃 ----
  // 实测两层共用同一条背景：本体 Root-*（rgb(40,40,40) + 8% 白渐变）与顶栏 ActionBar-*。
  // 顶栏跟随本体走透明，否则会在玻璃上盖一条更深的横带。
  codeGlass: true,
  codeAlpha: 10,
  codeBlur: 26,
  codeRadius: 18,

  // ---- Writing 卡片（GPT 回复里那块可编辑的 Writing 面板）----
  // 卡片自己背景透明，实色来自内部两层：
  //   div[class*='writing-block-surface'] > div[class*='pointer-events-none']（inset-0 z-[-1] 的垫底）
  //   与它的 <header>（都是 color(srgb 0.173726 …)）。
  writingGlass: true,
  writingAlpha: 9,
  writingBlur: 26,
  // 用户消息气泡：原生 rgb(23,62,118) 深蓝实色 + 22px 圆角，内部没有实色子层。
  // 颜色保留原生蓝（那是「我说的」这层语义），只把不透明度交出来。
  bubbleGlass: true,
  bubbleAlpha: 34,
  bubbleBlur: 32,

  // ---- 字体 ----
  // fontSetId 指向 fontsets 库里的一份预设（随包或用户层）；
  // themeSize / themeFamily 是「在预设之上再微调」的内联覆盖层，优先级更高 ——
  // 这样用户既能整体换一套字体方案，也能只把 h1 调大两号而不动其他。
  fontSetId: "preset-font",
  fontCustom: true,
  themeSize: {},
  themeFamily: {},

  // ---- 吉祥物 / 头像 ----
  ropeShown: false,
  ropeForm: "deepseek",
  ropeScale: 1.15,
  noticeSeen: "",
  avatarEnabled: false,
  avatarSize: 40,
  avatarRadius: 100,
  mascotImage: "",

  // ---- 特效 ----
  fxEnabled: false,
  fxClick: true,
  fxClickStyle: "ripple",
  fxClickSize: 140,
  fxClickGlow: 60,
  fxTrail: true,
  fxTrailStyle: "comet",
  fxTrailLength: 420,
  fxTrailWidth: 3,
  fxTrailGlow: 60,
  fxOpacity: 85,
  fxBlend: "screen",
  fxColorMode: "accent",
  fxColor: "#4f8cff",

  // ---- 视差 ----
  parallaxEnabled: false,
  parallaxBg: 1,
  parallaxUi: false,
  parallaxSmooth: 85,

  // ---- Codex 专属（dsh 没有对应物，新增） ----
  cweEnabled: true,
  cweInjectOnStart: true,
  cweUiAlpha: 0.30,
  cweUiAlphaMain: 0.24,
  cwePort: 9333,
  cweAutoRelaunch: true,

  // ---- 内部 ----
  settingsVersion: SETTINGS_VERSION,
};

const num = (v, lo, hi, d) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const str = (v, d, max = 4096) => (typeof v === "string" ? v.slice(0, max) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const arrOf = (v, list, d) => (Array.isArray(v) ? v.filter((x) => list.includes(x)) : d);
const colorStr = (v, d) => (typeof v === "string" && /^#([0-9a-f]{3,8})$/i.test(v) ? v : d);
/**
 * 键值映射清洗：字体覆盖层用（{ "markdown-h1": 22, "composer": "PingFang SC" }）。
 *
 * 三条约束：
 *   1. 键必须像键（1..64 的标识符），不接受任意串 —— 这些键最后会拼成 CSS 变量名；
 *   2. 值域钳制在这里，上层（页面/面板）就不用再验一次；
 *   3. 条数上限 max 防止 config.json 被塞爆。
 * 坏条目直接丢，不抛 —— 一个键写错不该让整份配置回默认。
 */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const mapOfNum = (v, lo, hi, d, max = 40) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...d };
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!KEY_RE.test(k)) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.min(hi, Math.max(lo, n));
    if (Object.keys(out).length >= max) break;
  }
  return out;
};
/**
 * 轮播组清洗 —— 移植 dsh client 的 readRotationGroups（lib/client.js:7021）。
 *
 * 为什么不能裸拷贝：rotationGroups 是用户能直接 POST 进 config.json 的键，
 * 里面每一项最后会驱动「多久换一张、按什么顺序换、换哪几张」。
 * 裸拷贝意味着页面能塞进任意对象（超长 name、非法 interval、非字符串 id），
 * 主机侧再拿去 setInterval 就会得到 NaN 间隔 / 永远轮不到的死组。
 *
 * 口径（与 dsh 逐条一致）：
 *   · id 必须是非空串，否则整组丢弃；
 *   · name 空则回落「轮播列表」，长度限 64；
 *   · interval 钳到 [1, 1440] 分钟；
 *   · order 只认 random | sequence；
 *   · trigger 只认 interval | videoEnd（旧存档缺键 ⇒ interval，加键是加性的）；
 *   · wallpaperIds 只留非空字符串，去重，上限 512。
 */
const ROTATION_INTERVAL_MIN = 1;
const ROTATION_INTERVAL_MAX = 1440;
const ROTATION_ORDER_VALUES = ["random", "sequence"];
const ROTATION_TRIGGER_VALUES = ["interval", "videoEnd"];
const readRotationGroups = (raw, fallbackInterval) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw.slice(0, 64)) {
    if (!g || typeof g !== "object" || Array.isArray(g)) continue;
    const id = typeof g.id === "string" && g.id ? g.id.slice(0, 64) : "";
    if (!id) continue;
    const ids = [];
    const seen = new Set();
    if (Array.isArray(g.wallpaperIds)) {
      for (const x of g.wallpaperIds) {
        if (typeof x !== "string" || !x) continue;
        const k = x.slice(0, 256);
        if (seen.has(k)) continue;
        seen.add(k);
        ids.push(k);
        if (ids.length >= 512) break;
      }
    }
    out.push({
      id,
      name: typeof g.name === "string" && g.name.trim() ? g.name.trim().slice(0, 64) : "轮播列表",
      interval: num(g.interval, ROTATION_INTERVAL_MIN, ROTATION_INTERVAL_MAX, fallbackInterval),
      order: oneOf(g.order, ROTATION_ORDER_VALUES, "sequence"),
      trigger: oneOf(g.trigger, ROTATION_TRIGGER_VALUES, "interval"),
      wallpaperIds: ids,
    });
  }
  return out;
};

const mapOfStr = (v, maxLen, d, max = 40) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...d };
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!KEY_RE.test(k)) continue;
    if (typeof raw !== "string") continue;
    const s = raw.trim().slice(0, maxLen);
    if (!s) continue;
    out[k] = s;
    if (Object.keys(out).length >= max) break;
  }
  return out;
};

/** 落盘前清洗：任何字段坏了都退回默认值，绝不抛异常。 */
export function sanitize(input) {
  const i = input && typeof input === "object" ? input : {};
  const d = DEFAULTS;
  const o = {};

  o.id = str(i.id, d.id, 256);
  o.wallpaperOpacity = num(i.wallpaperOpacity, 0, 100, d.wallpaperOpacity);
  o.wallpaperBlur = num(i.wallpaperBlur, 0, 40, d.wallpaperBlur);
  o.backgroundBrightness = num(i.backgroundBrightness, 0, 200, d.backgroundBrightness);
  o.backgroundContrast = num(i.backgroundContrast, 0, 200, d.backgroundContrast);
  o.backgroundSaturate = num(i.backgroundSaturate, 0, 300, d.backgroundSaturate);
  o.scrim = num(i.scrim, 0, 1, d.scrim);
  o.border = num(i.border, 0, 1, d.border);
  o.blur = num(i.blur, 0, 40, d.blur);
  o.switchTransition = oneOf(i.switchTransition, ["cut", "fade", "slide", "zoom", "wipe"], d.switchTransition);
  o.switchTransitionDir = oneOf(i.switchTransitionDir, ["left", "right", "up", "down"], d.switchTransitionDir);
  o.switchTransitionSpeed = oneOf(i.switchTransitionSpeed, ["fast", "normal", "slow"], d.switchTransitionSpeed);
  o.rotationEnabled = bool(i.rotationEnabled, d.rotationEnabled);
  o.pictureSlideSeconds = num(i.pictureSlideSeconds, 0, 3600, d.pictureSlideSeconds);
  o.rotationGroupId = str(i.rotationGroupId, d.rotationGroupId, 256);
  // 用 readRotationGroups 而不是裸 Array.slice：组里的 interval/order/trigger 会直接驱动
  // 宿主定时器与选片，必须在这里钳住（见该函数的注释）。
  o.rotationGroups = readRotationGroups(i.rotationGroups, d.rotationInterval);
  o.rotationInterval = num(i.rotationInterval, ROTATION_INTERVAL_MIN, ROTATION_INTERVAL_MAX, d.rotationInterval);
  o.rotationSeeded = bool(i.rotationSeeded, d.rotationSeeded);
  o.hiddenIds = Array.isArray(i.hiddenIds) ? i.hiddenIds.map((x) => String(x)).slice(0, 4096) : d.hiddenIds;
  o.playbackRate = num(i.playbackRate, 0.1, 4, d.playbackRate);
  o.videoVolume = num(i.videoVolume, 0, 1, d.videoVolume);
  o.videoAudioEnabled = bool(i.videoAudioEnabled, d.videoAudioEnabled);
  o.flip = bool(i.flip, d.flip);
  o.objectFit = oneOf(i.objectFit, ["cover", "contain", "fill", "none", "scale-down"], d.objectFit);
  o.layerPositionX = num(i.layerPositionX, 0, 100, d.layerPositionX);
  o.layerPositionY = num(i.layerPositionY, 0, 100, d.layerPositionY);
  o.layerScale = num(i.layerScale, 10, 400, d.layerScale);
  o.typeFilter = arrOf(i.typeFilter, ["video", "image"], d.typeFilter);
  o.contentRatingFilter = arrOf(i.contentRatingFilter, ["everyone", "pg13", "mature", "unrated"], d.contentRatingFilter);

  o.accent = colorStr(i.accent, d.accent);
  o.extraGlassSelectors = str(i.extraGlassSelectors, d.extraGlassSelectors, 8192);
  o.settingsWindowTransparency = num(i.settingsWindowTransparency, 0, 100, d.settingsWindowTransparency);
  o.settingsWindowBlur = num(i.settingsWindowBlur, 0, 60, d.settingsWindowBlur);
  o.conversationColor = colorStr(i.conversationColor, d.conversationColor);
  o.floatersTransparency = num(i.floatersTransparency, 0, 100, d.floatersTransparency);
  o.floatersBlur = num(i.floatersBlur, 0, 60, d.floatersBlur);
  o.leftSidebarCornerRadius = str(i.leftSidebarCornerRadius, d.leftSidebarCornerRadius, 8);
  o.rightSidebarTransparency = num(i.rightSidebarTransparency, 0, 100, d.rightSidebarTransparency);
  o.rightSidebarBlur = num(i.rightSidebarBlur, 0, 60, d.rightSidebarBlur);
  o.titlebarGlass = bool(i.titlebarGlass, d.titlebarGlass);
  o.rightSidebarGlass = bool(i.rightSidebarGlass, d.rightSidebarGlass);
  o.overlayGlass = bool(i.overlayGlass, d.overlayGlass);
  o.titlebarTransparency = num(i.titlebarTransparency, 0, 100, d.titlebarTransparency);
  o.titlebarBlur = num(i.titlebarBlur, 0, 60, d.titlebarBlur);
  o.sidebarGlass = bool(i.sidebarGlass, d.sidebarGlass);
  o.conversationSidebarGlass = bool(i.conversationSidebarGlass, o.sidebarGlass && d.conversationSidebarGlass);
  o.conversationSidebarAlpha = num(i.conversationSidebarAlpha, 0, 100, d.conversationSidebarAlpha);
  o.conversationSidebarBlur = num(i.conversationSidebarBlur, 0, 60, d.conversationSidebarBlur);
  o.conversationSidebarTint = colorStr(i.conversationSidebarTint, d.conversationSidebarTint);
  o.conversationSidebarSaturate = num(i.conversationSidebarSaturate, 100, 200, d.conversationSidebarSaturate);
  o.conversationSidebarBrightness = num(i.conversationSidebarBrightness, 90, 130, d.conversationSidebarBrightness);
  o.conversationSidebarEdge = bool(i.conversationSidebarEdge, d.conversationSidebarEdge);
  o.sidebarBlur = num(i.sidebarBlur, 0, 60, d.sidebarBlur);
  o.sidebarAlpha = num(i.sidebarAlpha, 0, 100, d.sidebarAlpha);
  o.sidebarColor = colorStr(i.sidebarColor, d.sidebarColor);
  o.sidebarContentAlpha = num(i.sidebarContentAlpha, 0, 100, d.sidebarContentAlpha);
  o.sidebarContentColor = i.sidebarContentColor === "" ? "" : colorStr(i.sidebarContentColor, d.sidebarContentColor);
  o.sidebarEdgeBlend = bool(i.sidebarEdgeBlend, d.sidebarEdgeBlend);
  o.composerGlass = bool(i.composerGlass, d.composerGlass);
  o.composerAlpha = num(i.composerAlpha, 0, 100, d.composerAlpha);
  o.composerBlur = num(i.composerBlur, 0, 60, d.composerBlur);
  o.composerRadius = num(i.composerRadius, 0, 40, d.composerRadius);
  o.composerChipGlass = bool(i.composerChipGlass, d.composerChipGlass);
  o.composerChipAlpha = num(i.composerChipAlpha, 0, 100, d.composerChipAlpha);
  o.composerPillGlass = bool(i.composerPillGlass, d.composerPillGlass);
  o.composerPillAlpha = num(i.composerPillAlpha, 0, 100, d.composerPillAlpha);
  o.codeGlass = bool(i.codeGlass, d.codeGlass);
  o.codeAlpha = num(i.codeAlpha, 0, 100, d.codeAlpha);
  o.codeBlur = num(i.codeBlur, 0, 60, d.codeBlur);
  o.codeRadius = num(i.codeRadius, 0, 40, d.codeRadius);
  o.writingGlass = bool(i.writingGlass, d.writingGlass);
  o.writingAlpha = num(i.writingAlpha, 0, 100, d.writingAlpha);
  o.writingBlur = num(i.writingBlur, 0, 60, d.writingBlur);
  o.bubbleGlass = bool(i.bubbleGlass, d.bubbleGlass);
  o.bubbleAlpha = num(i.bubbleAlpha, 0, 100, d.bubbleAlpha);
  o.bubbleBlur = num(i.bubbleBlur, 0, 60, d.bubbleBlur);

  o.fontSetId = str(i.fontSetId, d.fontSetId, 128);
  o.fontCustom = bool(i.fontCustom, d.fontCustom);
  // 字号只收 6..96 的数字键值对；字体族名收字符串。上限 40 条，够用且不会把 config 撑爆。
  o.themeSize = mapOfNum(i.themeSize, 6, 96, d.themeSize, 40);
  o.themeFamily = mapOfStr(i.themeFamily, 120, d.themeFamily, 40);

  o.ropeShown = bool(i.ropeShown, d.ropeShown);
  o.ropeForm = str(i.ropeForm, d.ropeForm, 64);
  o.ropeScale = num(i.ropeScale, 0.1, 5, d.ropeScale);
  o.noticeSeen = str(i.noticeSeen, d.noticeSeen, 32);
  o.avatarEnabled = bool(i.avatarEnabled, d.avatarEnabled);
  o.avatarSize = num(i.avatarSize, 12, 160, d.avatarSize);
  o.avatarRadius = num(i.avatarRadius, 0, 100, d.avatarRadius);
  o.mascotImage = str(i.mascotImage, d.mascotImage, 512);

  o.fxEnabled = bool(i.fxEnabled, d.fxEnabled);
  o.fxClick = bool(i.fxClick, d.fxClick);
  o.fxClickStyle = oneOf(i.fxClickStyle, ["ripple", "burst", "ring", "star"], d.fxClickStyle);
  o.fxClickSize = num(i.fxClickSize, 10, 600, d.fxClickSize);
  o.fxClickGlow = num(i.fxClickGlow, 0, 100, d.fxClickGlow);
  o.fxTrail = bool(i.fxTrail, d.fxTrail);
  o.fxTrailStyle = oneOf(i.fxTrailStyle, ["comet", "line", "dots", "spark"], d.fxTrailStyle);
  o.fxTrailLength = num(i.fxTrailLength, 20, 2000, d.fxTrailLength);
  o.fxTrailWidth = num(i.fxTrailWidth, 1, 40, d.fxTrailWidth);
  o.fxTrailGlow = num(i.fxTrailGlow, 0, 100, d.fxTrailGlow);
  o.fxOpacity = num(i.fxOpacity, 0, 100, d.fxOpacity);
  o.fxBlend = oneOf(i.fxBlend, ["screen", "normal", "overlay", "lighten", "plus-lighter"], d.fxBlend);
  o.fxColorMode = oneOf(i.fxColorMode, ["accent", "custom", "rainbow"], d.fxColorMode);
  o.fxColor = colorStr(i.fxColor, d.fxColor);

  o.parallaxEnabled = bool(i.parallaxEnabled, d.parallaxEnabled);
  o.parallaxBg = num(i.parallaxBg, 0, 5, d.parallaxBg);
  o.parallaxUi = bool(i.parallaxUi, d.parallaxUi);
  o.parallaxSmooth = num(i.parallaxSmooth, 0, 100, d.parallaxSmooth);


  o.cweEnabled = bool(i.cweEnabled, d.cweEnabled);
  o.cweInjectOnStart = bool(i.cweInjectOnStart, d.cweInjectOnStart);
  o.cweUiAlpha = num(i.cweUiAlpha, 0, 1, d.cweUiAlpha);
  o.cweUiAlphaMain = num(i.cweUiAlphaMain, 0, 1, d.cweUiAlphaMain);
  o.cwePort = num(i.cwePort, 1024, 65535, d.cwePort);
  o.cweAutoRelaunch = bool(i.cweAutoRelaunch, d.cweAutoRelaunch);

  o.settingsVersion = SETTINGS_VERSION;
  return o;
}

/** 面板分组：让设置 UI 由数据驱动，不写死布局。 */
export const GROUPS = [
  {
    id: "wallpaper", title: "壁纸",
    fields: [
      { key: "wallpaperOpacity", label: "壁纸不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "wallpaperBlur", label: "壁纸模糊", type: "range", min: 0, max: 40, unit: "px" },
      { key: "backgroundBrightness", label: "亮度", type: "range", min: 0, max: 200, unit: "%" },
      { key: "backgroundContrast", label: "对比度", type: "range", min: 0, max: 200, unit: "%" },
      { key: "backgroundSaturate", label: "饱和度", type: "range", min: 0, max: 300, unit: "%" },
      { key: "scrim", label: "压暗遮罩", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "objectFit", label: "铺满方式", type: "select", options: ["cover", "contain", "fill", "none", "scale-down"] },
      { key: "layerPositionX", label: "水平位置", type: "range", min: 0, max: 100, unit: "%" },
      { key: "layerPositionY", label: "垂直位置", type: "range", min: 0, max: 100, unit: "%" },
      { key: "layerScale", label: "缩放", type: "range", min: 10, max: 400, unit: "%" },
      { key: "flip", label: "水平翻转", type: "toggle" },
      { key: "switchTransition", label: "切换动效", type: "select", options: ["cut", "fade", "slide", "zoom", "wipe"] },
      { key: "rotationEnabled", label: "自动轮换", type: "toggle" },
      { key: "pictureSlideSeconds", label: "轮换间隔", tip: "单位：秒；0 = 关闭轮换", type: "range", min: 0, max: 3600, unit: "秒" },
    ],
  },
  {
    id: "glass", title: "玻璃与界面",
    fields: [
      // 这两个是「界面能看到多少壁纸」的总开关：内容面与外壳各一处，
      // 但渲染时按「补差值」合并（见 runtime.js themeCss），不会两层连乘把壁纸压黑。
      { key: "cweUiAlpha", label: "界面不透明度", tip: "越大越遮壁纸；调小就能看见更多本人", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "cweUiAlphaMain", label: "外壳不透明度", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "accent", label: "强调色", type: "color" },
      // 设置面板自己是独立窗口（不是会话内的一层），透明度与模糊单列，
      // 因为它的底是壁纸而不是会话面，混用 sidebarAlpha 会调不准。
      { key: "settingsWindowTransparency", label: "设置面板不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "settingsWindowBlur", label: "设置面板模糊", type: "range", min: 0, max: 60, unit: "px" },
      { key: "sidebarGlass", label: "左侧图标栏玻璃", type: "toggle" },
      { key: "sidebarBlur", label: "图标栏模糊", tip: "超过约 16px 会把这条窄栏糊成一块灰板，看不清壁纸", type: "range", min: 0, max: 60, unit: "px" },
      { key: "sidebarAlpha", label: "图标栏不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "conversationSidebarGlass", label: "会话列表玻璃", type: "toggle", tip: "左侧的项目与聊天列表" },
      { key: "conversationSidebarAlpha", label: "会话列表不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "conversationSidebarBlur", label: "会话列表模糊", tip: "超过约 16px 会把这条窄栏糊成一块灰板，看不清壁纸", type: "range", min: 0, max: 60, unit: "px" },
      { key: "conversationSidebarTint", label: "会话列表墨色", tip: "玻璃自己的底色。深冷墨能透出壁纸又不发灰；改成纯白就成了浅色玻璃", type: "color" },
      { key: "conversationSidebarSaturate", label: "会话列表色彩浓度", tip: "100% 起发灰，165% 能让壁纸的颜色渗进这块玻璃，超过 200% 会荧光", type: "range", min: 100, max: 200, unit: "%" },
      { key: "conversationSidebarBrightness", label: "会话列表提亮", tip: "窄栏被模糊平均后容易发闷，112% 左右能把暗部提起来；超过 130% 会过曝发白", type: "range", min: 90, max: 130, unit: "%" },
      { key: "conversationSidebarEdge", label: "会话列表边缘厚度", tip: "顶缘高光 + 右缘 1px 亮线 + 底部内阴影，关掉就退回一块平涂的板", type: "toggle" },
      { key: "sidebarEdgeBlend", label: "侧栏接缝融入玻璃", type: "toggle" },
      { key: "titlebarGlass", label: "标题栏玻璃", tip: "下面两个滑块都是 0 时标题栏是纯透明的，这个开关拨了看不出差别；先把不透明度推到 80% 左右、模糊推到 18px", type: "toggle" },
      { key: "titlebarTransparency", label: "标题栏不透明度", tip: "0% = 完全透明，等于没有玻璃；86% 左右是常规磨砂，100% 是实心", type: "range", min: 0, max: 100, unit: "%" },
      { key: "titlebarBlur", label: "标题栏模糊", tip: "0px 时背景不模糊；14–24px 是磨砂区间，超过 40px 就糊成一块色板", type: "range", min: 0, max: 60, unit: "px" },
      { key: "rightSidebarGlass", label: "右侧面板玻璃", tip: "右侧面板收起时宽度为 0，拨这个看不到任何变化；先把右面板展开再看", type: "toggle" },
      { key: "rightSidebarTransparency", label: "右侧面板不透明度", tip: "同样需要右面板展开才有画面可看", type: "range", min: 0, max: 100, unit: "%" },
      { key: "rightSidebarBlur", label: "右侧面板模糊", tip: "同样需要右面板展开才有画面可看", type: "range", min: 0, max: 60, unit: "px" },
      { key: "overlayGlass", label: "菜单与弹窗玻璃", tip: "只在菜单、对话框、搜索层弹出时生效，平时主界面上看不到", type: "toggle" },
      { key: "floatersTransparency", label: "浮层不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "floatersBlur", label: "浮层模糊", type: "range", min: 0, max: 60, unit: "px" },
      { key: "conversationColor", label: "会话面颜色", type: "color" },
      { key: "extraGlassSelectors", label: "额外玻璃选择器", type: "text" },
    ],
  },
  {
    // 输入框单独成页：它有三层实色（输入区 / chip 行 / 模型胶囊），
    // 每层要单独调，挤在「玻璃与界面」里控件太多，看不出谁管谁。
    id: "composer", title: "输入框",
    fields: [
      { key: "composerGlass", label: "输入框玻璃", type: "toggle" },
      { key: "composerAlpha", label: "输入区不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "composerBlur", label: "输入区模糊", type: "range", min: 0, max: 60, unit: "px" },
      { key: "composerRadius", label: "输入区圆角", type: "range", min: 0, max: 40, unit: "px" },
      { key: "composerChipGlass", label: "上方工具条玻璃", type: "toggle" },
      { key: "composerChipAlpha", label: "工具条不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "composerPillGlass", label: "模型胶囊玻璃", type: "toggle" },
      { key: "composerPillAlpha", label: "模型胶囊不透明度", type: "range", min: 0, max: 100, unit: "%" },
    ],
  },
  {
    // 代码块单独一页：本体 + 顶栏两层，实色藏在内层 hash 类上。
    id: "code", title: "代码块",
    fields: [
      { key: "codeGlass", label: "代码块玻璃", type: "toggle" },
      { key: "codeAlpha", label: "代码块不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "codeBlur", label: "代码块模糊", type: "range", min: 0, max: 60, unit: "px" },
      { key: "codeRadius", label: "代码块圆角", type: "range", min: 0, max: 40, unit: "px" },
    ],
  },
  {
    // 对话内容单独一页：GPT 的「写作」卡片（Writing 可编辑面板）和我发给它的消息气泡。
    // 这两块是会话正文里最显眼的两个实色块，和代码块/输入框的调参节奏完全不同，所以分开。
    id: "bubble", title: "写作与消息",
    fields: [
      { key: "writingGlass", label: "写作区域玻璃", type: "toggle" },
      { key: "writingAlpha", label: "写作区域不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "writingBlur", label: "写作区域模糊", type: "range", min: 0, max: 60, unit: "px" },
      { key: "bubbleGlass", label: "我发的消息气泡玻璃", type: "toggle" },
      { key: "bubbleAlpha", label: "消息气泡不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "bubbleBlur", label: "消息气泡模糊", type: "range", min: 0, max: 60, unit: "px" },
    ],
  },
  {
    id: "fx", title: "特效",
    fields: [
      { key: "fxEnabled", label: "启用特效", type: "toggle" },
      { key: "fxClick", label: "点击特效", type: "toggle" },
      { key: "fxClickStyle", label: "点击样式", type: "select", options: ["ripple", "burst", "ring", "star"] },
      { key: "fxClickSize", label: "点击半径", type: "range", min: 10, max: 600, unit: "px" },
      { key: "fxTrail", label: "鼠标拖尾", type: "toggle" },
      { key: "fxTrailStyle", label: "拖尾样式", type: "select", options: ["comet", "line", "dots", "spark"] },
      { key: "fxTrailLength", label: "拖尾长度", type: "range", min: 20, max: 2000 },
      { key: "fxTrailWidth", label: "拖尾粗细", type: "range", min: 1, max: 40, unit: "px" },
      { key: "fxOpacity", label: "特效不透明度", type: "range", min: 0, max: 100, unit: "%" },
      { key: "fxBlend", label: "混合模式", type: "select", options: ["screen", "normal", "overlay", "lighten", "plus-lighter"] },
      { key: "fxColorMode", label: "配色", type: "select", options: ["accent", "custom", "rainbow"] },
      { key: "fxColor", label: "自定义色", type: "color" },
    ],
  },
  {
    id: "parallax", title: "视差",
    fields: [
      { key: "parallaxEnabled", label: "启用视差", type: "toggle" },
      { key: "parallaxBg", label: "背景深度", type: "range", min: 0, max: 5, step: 0.1 },
      { key: "parallaxUi", label: "界面视差", type: "toggle" },
      { key: "parallaxSmooth", label: "平滑度", type: "range", min: 0, max: 100 },
    ],
  },
  {
    id: "mascot", title: "头像与吉祥物",
    fields: [
      { key: "avatarEnabled", label: "替换头像", type: "toggle" },
      { key: "avatarSize", label: "头像尺寸", type: "range", min: 12, max: 160, unit: "px" },
      { key: "avatarRadius", label: "圆角", type: "range", min: 0, max: 100, unit: "%" },
      { key: "ropeShown", label: "显示吉祥物", type: "toggle" },
      { key: "ropeScale", label: "吉祥物缩放", type: "range", min: 0.1, max: 5, step: 0.05 },
      { key: "ropeForm", label: "吉祥物形态", type: "select", options: ["deepseek", "orb", "ghost", "cat"] },
    ],
  },
  {
    id: "font", title: "字体",
    fields: [
      { key: "fontSetId", label: "字体方案", type: "text" },
      { key: "fontCustom", label: "允许覆盖", type: "toggle" },
    ],
  },
  {
    id: "host", title: "宿主",
    fields: [
      { key: "cweEnabled", label: "总开关", type: "toggle" },
      { key: "cweInjectOnStart", label: "启动自动注入", type: "toggle" },
      { key: "cwePort", label: "调试端口", type: "range", min: 1024, max: 65535 },
      { key: "cweAutoRelaunch", label: "Dock 启动补端口", type: "toggle" },
    ],
  },
];

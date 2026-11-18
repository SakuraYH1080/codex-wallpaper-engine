/**
 * src/inject/panel.js —— 设置面板（页面内，Shadow DOM，与 Codex 原生 UI 完全隔离）
 *
 * 为什么面板在页面里而不是在宿主上：
 *   Codex 插件体系只有 skills / MCP / hooks 三类扩展点，没有「给宿主插件做设置页」的位置。
 *   DSH 那边的 React 面板走 dsh-client-ui-slots，Codex 没有对应物。
 *   所以面板做成页面内的浮层 —— 它读写的仍然只有宿主那一份 config.json。
 *
 * 三条纪律：
 *   1. 所有节点都住在 #cwe-panel-host 的 shadow root 里，不污染 Codex 的 DOM 与样式。
 *   2. 面板不持有状态：cfg 是宿主的镜像，每次改动都 POST /settings，宿主再推 payload 回来。
 *   3. 打不开就静默 —— 面板是可选的，主功能（壁纸本身）不依赖它。
 */
(function () {
  "use strict";
  var CWE = window.__CWE;
  if (!CWE) return;
  // 幂等：版本号 + 指纹都对上，才复用页面里已有的面板。
  //
  // 只比版本号踩过坑：同一个版本号下改过两次样式，第二次的改动永远进不来 ——
  // 页面里的旧实例版本号相同，直接 return，新的 CSS 一个字都到不了 DOM。
  // 所以改样式/结构时改 FP 就行，不必每次都想版本号该叫几。
  var VERSION = "0.17.8";
  // 结构性改动（横向 tab → 左侧导航 + 玻璃变量 + 单次挂载）必须同时升 FP：
  // 只升版本号时，若同名版本曾注入过，旧实例会原样留在页面上。
  var FP = "native-21-no-note"
  // 实例令牌：页面里可能残留上一次注入的观察器，只有当前实例能继续挂入口。
  var INSTANCE = {};
  if (CWE.panel && CWE.panel.version === VERSION && CWE.panel.fp === FP) return;

  var HOST_ID = "cwe-panel-host";

  // 重装时必须先把旧面板节点摘掉。
  // 踩过的坑：新实例只赋了 CWE.panel，却没碰 DOM —— render() 开头 if (!host) return，
  // 而 host 只在 ensureHost() 里赋值、ensureHost() 只在 show() 里调，于是新实例
  // 一次渲染都没做，页面上留着的还是旧实例那份 shadow host（旧 CSS、旧 launcher 位置），
  // 表现为「版本号是新的、CSS 是旧的」。换 FP 时这里会把旧的连根拔掉。
  if (CWE.panel && typeof CWE.panel.destroy === "function") {
    try { CWE.panel.destroy(); } catch (eOld) { /* 老实例缺 destroy 时下面仍做 DOM 清理 */ }
  }
  (function dropStaleHost() {
    var old = document.getElementById(HOST_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var oldEntry = document.getElementById(HOST_ID + "-entry");
    if (oldEntry && oldEntry.parentNode) oldEntry.parentNode.removeChild(oldEntry);
  })();

  var state = {
    open: false,
    tab: "wallpaper",
    cfg: null,
    groups: [],
    defaults: null,
    inv: null,
    base: "",
    // 资源面：has.mascot / has.user / has.ai 是 HEAD 探针的结论，
    // fontsets 是随包 + 用户层的合并清单，sysFonts 是系统字体（懒加载，可能上千条）
    has: { mascot: false, user: false, ai: false },
    fontsets: [],
    // 外观预设：presets 是 listPresets() 的合并清单（内置 + 用户层），
    // presetKeys 是宿主反推出来的「哪些键算外观」，面板只拿来显示数量。
    presets: [],
    presetKeys: [],
    sysFonts: null,
    fontsLoading: false,
    loading: false,
    message: "",
    // message 的语义：tone 决定颜色（空 / ok / err），ttl 到点自动退回「改动即时生效」。
    // 老面板把它当一次性的字符串，下一次 loadAll 就清空 —— 用户点保存唯一一次反馈经常看不见。
    messageTone: "",
    messageAt: 0,
    saveTimer: null,
    pending: {},
    // ---- 以下为 0.10.0 新增 ----
    // query：顶部搜索框。非空时 body 显示跨组搜索结果，不用挨个 tab 翻 150 个键。
    query: "",
    // paintedTab：当前 body 里实打实画的是哪个 tab。
    // 滚动位置按 tab 记忆，靠它对账 —— 不记它就没法在切走时存 scrollTop。
    paintedTab: "",
    // dragging：正在拖 range 的松手等待窗口。期间禁止任何重绘，
    // 否则 DOM 被换掉 → 拖拽中断 + 滚动跳顶（用户报的第一条）。
    dragging: 0,
    pendingPaint: false,
    // presetError：/presets 失败时不再假装「还没有预设」，把原因和磁盘路径显示出来。
    presetError: null,
    // undo：删除预设后的后悔药。宿主 DELETE 之后就没了，所以删之前先把 values 抓下来。
    undo: null,
    // renaming：正在改名的那一行预设 id。空串 = 没有一行在改名。
    renaming: "",
    // appliedId：最后一次应用的预设 id。只用于给那一行打 data-cur，不改任何值。
    appliedId: "",
    // presetDir：预设落在磁盘哪里。/presets 失败时把路径和错误一起显示，用户能自己去看。
    presetDir: "",
    // fontsErr / fontsAt：系统字体是一次性大列表，失败要能重试，不是永远「未加载」。
    fontsErr: "",
    fontsAt: 0,
    scheme: "",
    dataRoot: "",
    destroyed: false,
    saveSeq: 0,
    loadSeq: 0,
    mountedEntry: false,
  };
  var scrollMemo = Object.create(null);
  // 骨架节点缓存：mount 一次之后所有更新都走这里，不再重建整棵树。
  var S = {};

  function base() {
    var s = (CWE && CWE.state) || {};
    return (s && s.base) || state.base || "";
  }
  function api(path) { return base() + "/wallpaper-engine" + path; }

  // ---------------- 与宿主通信 ----------------

  function getJson(path) {
    return fetch(api(path), { cache: "no-store" }).then(function (r) { return r.json(); });
  }
  function postJson(path, body) {
    return fetch(api(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  /** HEAD 探一张图在不在 —— 404 就是没设过，不必把破图塞给用户看。 */
  function headExists(path) {
    return fetch(api(path), { method: "HEAD", cache: "no-store" })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  /** 资源面探针：吉祥物 + 两个头像槽 + 字体集清单，四路并发。 */
  function loadFaces() {
    return Promise.all([
      headExists("/mascot"),
      headExists("/avatar/user"),
      headExists("/avatar/ai"),
      getJson("/fontsets/list").catch(function () { return null; }),
    ]).then(function (out) {
      state.has = { mascot: !!out[0], user: !!out[1], ai: !!out[2] };
      // 宿主回的是 { ok, fontsets:[...] }，不是 sets —— 字段名对齐路由，别猜
      if (out[3] && out[3].fontsets) state.fontsets = out[3].fontsets;
    });
  }

  /** 传一张图到 /mascot 或 /avatar/<side>。失败原因原样回显，不吞。 */
  /** 上传一张图到 /mascot 或 /avatar/<side>。失败原因原样回显，不吞。 */
  function uploadImage(path, file) {
    if (!file) return;
    setMessage("上传中：" + file.name, "", 0);
    fetch(api(path), {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.ok) { setMessage("已更新", "ok", 2400); return loadAll(); }
      setMessage("失败：" + ((r && r.error) || "未知"), "err", 6000);
    }).catch(function (e) {
      setMessage("上传失败：" + (e && e.message || e), "err", 6000);
    });
  }

  function deleteImage(path) {
    fetch(api(path), { method: "DELETE" }).then(function (r) { return r.json(); }).then(function () {
      setMessage("已清除", "ok", 2400);
      return loadAll();
    }).catch(function (e) {
      setMessage("清除失败：" + (e && e.message || e), "err", 6000);
    });
  }

  function openPicker(accept, onPick) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    root.appendChild(input);
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      input.remove();
      if (f) onPick(f);
    });
    input.click();
  }

  /**
   * 拉一遍全部状态。
   *
   * 三个必须保留的细节：
   *  1. 失败要能看见。早先每路都 .catch(() => null)，宿主没起来时面板是一片空白，
   *     用户只看得到「没有壁纸」，看不到「宿主没连上」。
   *  2. /presets 单独 catch：预设目录坏了不该让整个面板陪葬，但错误要显示在预设页。
   *  3. 不清 state.message：老代码在末尾无条件 state.message = ""，
   *     「已保存 / 已导入」经常一个字都没显示就被抹掉 —— 这是反馈看起来「没反应」的主因。
   */
  function loadAll(opts) {
    var seq = ++state.loadSeq;
    var quiet = !!(opts && opts.quiet);
    if (state.destroyed) return Promise.resolve(null);
    if (!quiet) state.loading = true;
    state.loadErr = null;
    syncStatus();
    return Promise.all([
      getJson("/settings").catch(function (e) { state.loadErr = "设置读取失败：" + (e && e.message || e); return null; }),
      getJson("/inventory").catch(function () { return null; }),
      loadFaces(),
      getJson("/presets").then(function (x) { state.presetError = null; return x; })
        .catch(function (e) { state.presetError = "预设清单读取失败：" + (e && e.message || e); return null; }),
    ]).then(function (out) {
      if (state.destroyed || seq !== state.loadSeq) return null;
      var st = out[0] || {};
      if (st.config) state.cfg = st.config;
      if (st.groups) state.groups = st.groups;
      if (st.defaults) state.defaults = st.defaults;
      // 原代码这里是 state.base = st.dataRoot ? state.base : state.base —— 两个分支写的是同一个值，
      // 等于没写。宿主给了 dataRoot 就用它，预设页要显示磁盘路径。
      if (st.dataRoot) state.dataRoot = st.dataRoot;
      if (out[1]) state.inv = out[1];
      var ps = out[3];
      if (ps) {
        state.presets = ps.presets || [];
        state.presetKeys = ps.keys || [];
        state.presetDir = ps.dir || ps.dataRoot || "";
      }
      if (state.presetError) state.loadErr = null; // 预设的错单独显示，不占全局横幅
      state.loading = false;
      applyGlass();
      applyScheme();
      paint(true);
    }).catch(function (e) {
      if (state.destroyed || seq !== state.loadSeq) return null;
      state.loading = false;
      setMessage("读取失败：" + (e && e.message || e), "err", 8000);
      paint(true);
    });
  }

  /** 改一个键：本地立即生效（滑块不卡），200ms 后批量提交。 */
  function patch(key, value) {
    if (!state.cfg) state.cfg = {};
    state.cfg[key] = value;
    state.pending[key] = value;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushPending, 200);
  }

  function patchMany(obj) {
    if (!state.cfg) state.cfg = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      state.cfg[k] = obj[k];
      state.pending[k] = obj[k];
    }
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushPending, 200);
  }

  /**
   * 提交攒下来的改动。
   *
   * 关键：回包只回写「这次改过的那几个控件」，不重画整页。
   * 老代码这里是 render() —— 宿主的清洗结果一回来，整棵树重建，
   * 于是出现了用户看到的那个现象：拖亮度条，拖到一半面板自己跳回顶部、
   * 滑块回弹到旧值（重建那一刻 value 还是宿主上一次的值）。
   */
  function flushPending() {
    state.saveTimer = null;
    var body = state.pending;
    var keys = [];
    state.pending = {};
    for (var k in body) if (Object.prototype.hasOwnProperty.call(body, k)) keys.push(k);
    if (!keys.length) return;
    var seq = ++state.saveSeq;
    postJson("/settings", body).then(function (r) {
      if (state.destroyed || seq !== state.saveSeq) return;
      if (!r || !r.config) return;
      // 宿主的清洗结果才是真值（范围钳制、枚举退化都在那儿）
      state.cfg = r.config;
      for (var i = 0; i < keys.length; i++) syncField(keys[i]);
      if (keys.indexOf("settingsWindowTransparency") >= 0 || keys.indexOf("settingsWindowBlur") >= 0) applyGlass();
      if (keys.indexOf("rotationGroups") >= 0 || keys.indexOf("rotationGroupId") >= 0) paint(true);
      if (keys.indexOf("cweLauncher") >= 0) syncStatus();
      if (state.presetDirty) { /* 预设脏标记留着，不影响这里 */ }
    }).catch(function (e) {
      if (state.destroyed || seq !== state.saveSeq) return;
      setMessage("保存失败：" + (e && e.message || e), "err", 6000);
    });
  }

  // ---------------- 轮播组 ----------------
  // 组的最小形状（与 settings-schema.mjs 的 readRotationGroups 对齐）：
  //   { id, name, interval(分钟), order: sequence|random, trigger: interval|videoEnd, wallpaperIds: [] }
  // 面板只做 CRUD；哪张在轮换由 controller 决定。

  function groups() {
    var g = state.cfg && state.cfg.rotationGroups;
    return Array.isArray(g) ? g : [];
  }

  function activeGroup() {
    var id = state.cfg && state.cfg.rotationGroupId;
    var list = groups();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  function newGroupId() {
    return "grp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /** 一次改动 = 整份 rotationGroups 提交（宿主会整组清洗，不做增量）。 */
  function saveGroups(list, activeId) {
    var body = { rotationGroups: list };
    if (activeId !== undefined) body.rotationGroupId = activeId;
    patchMany(body);
  }

  function createGroup() {
    var list = groups().slice();
    var g = { id: newGroupId(), name: "轮播列表 " + (list.length + 1), interval: 30, order: "sequence", trigger: "interval", wallpaperIds: [] };
    list.push(g);
    saveGroups(list, g.id);
    setMessage("已新建「" + g.name + "」", "ok", 2400);
  }

  function updateGroup(id, field, value) {
    var list = groups().map(function (g) {
      if (!g || g.id !== id) return g;
      var next = {};
      for (var k in g) if (Object.prototype.hasOwnProperty.call(g, k)) next[k] = g[k];
      next[field] = value;
      return next;
    });
    saveGroups(list);
  }

  /**
   * 删掉一张已上传的壁纸。
   * 宿主的 handleRemove 只按 id 删文件 + 元数据，不动 config.id ——
   * 要是删的正好是当前在用的那张，壁纸会整个黑掉，所以先看要不要连带切走。
   */
  function removeWallpaper(id) {
    if (!id) return;
    var inv = state.inv || {};
    var all = inv.wallpapers || [];
    var rest = all.filter(function (w) { return !w.hidden && w.id !== id; });
    var wasCur = !!(state.cfg && state.cfg.id === id);
    var title = "";
    all.forEach(function (w) { if (w.id === id) title = w.title || w.id; });
    var ask = "删除壁纸「" + (title || id) + "」？\n\n文件会从磁盘删掉，不能撤销。" +
              (wasCur ? "\n\n它是当前正在用的那张，删掉后会切到清单里的下一张。" : "");
    if (!confirm(ask)) return;

    fetch(api("/remove"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: id }),
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r || r.ok === false) throw new Error((r && r.error) || "宿主拒绝");
      // 先切走再刷新：顺序反了的话中间会有一帧黑屏
      if (wasCur && rest.length) {
        return postJson("/settings", { id: rest[0].id }).then(function () {
          setMessage("已删除「" + (title || id) + "」，切到「" + (rest[0].title || rest[0].id) + "」", "ok", 3600);
          return loadAll();
        });
      }
      setMessage("已删除「" + (title || id) + "」", "ok", 3200);
      return loadAll();
    }).catch(function (e) {
      setMessage("删除失败：" + (e && e.message || e), "err", 6000);
    });
  }

  function deleteGroup(id) {
    var list = groups().filter(function (g) { return g && g.id !== id; });
    var activeId = state.cfg && state.cfg.rotationGroupId;
    saveGroups(list, activeId === id ? (list[0] ? list[0].id : "") : undefined);
  }

  function toggleMember(groupId, wallpaperId) {
    var list = groups().map(function (g) {
      if (!g || g.id !== groupId) return g;
      var ids = Array.isArray(g.wallpaperIds) ? g.wallpaperIds.slice() : [];
      var at = ids.indexOf(wallpaperId);
      if (at >= 0) ids.splice(at, 1);
      else ids.push(wallpaperId);
      var next = {};
      for (var k in g) if (Object.prototype.hasOwnProperty.call(g, k)) next[k] = g[k];
      next.wallpaperIds = ids;
      return next;
    });
    saveGroups(list);
    paint(true);
  }

  function pick(id) {
    postJson("/settings", { id: id }).then(function (r) {
      if (r && r.config) state.cfg = r.config;
      setMessage("已切换", "ok", 1600);
      // 选中高亮变了：同一 tab 内重绘，滚动位置由 scrollMemo 保住
      paint(true);
    }).catch(function (e) {
      setMessage("切换失败：" + (e && e.message || e), "err", 6000);
    });
  }

  function reset() {
    fetch(api("/settings"), { method: "DELETE" }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.config) state.cfg = r.config;
      setMessage("已恢复默认", "ok", 2800);
      applyGlass();
      applyScheme();
      paint(true);
    }).catch(function (e) {
      setMessage("恢复失败：" + (e && e.message || e), "err", 6000);
    });
  }

  /**
   * 上传一个文件。
   *
   * 两个必须保留的行为：
   *  1. 失败要把宿主给的原因说出来。早先只写死「上传失败」，413（超过上限）和
   *     400（类型不支持）在界面上长得一模一样 —— 用户报「导入视频壁纸没显示出来」
   *     那次，真因就是 413，但界面上什么也看不到。
   *  2. 大文件要报进度。一条 4K 视频几百 MB，POST 期间界面一直停在「上传中」，
   *     分不清是在传还是卡死了。用 XHR 的 upload.onprogress 换掉 fetch 就够。
   *  ★ 但进度只能改页脚那行字，绝不能 paint()：老代码每 50ms 重建一次整棵树，
   *    几百 MB 的视频能让面板整个卡住，这就是「上传时界面假死」的来源。
   */
  function upload(files) {
    if (!files || !files.length) return;
    var f = files[0];
    var mb = Math.max(1, Math.round(f.size / 1048576));
    setMessage("上传中：" + f.name + "（" + mb + " MB）", "", 0);
    var url = api("/upload?name=" + encodeURIComponent(f.name) + "&title=" + encodeURIComponent(f.name.replace(/\.[^.]+$/, "")));
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.upload.onprogress = function (ev) {
      if (!ev.lengthComputable) return;
      var pct = Math.round((ev.loaded / ev.total) * 100);
      setMessage("上传中：" + f.name + "　" + pct + "%（" + Math.round(ev.loaded / 1048576) + "/" + mb + " MB）", "", 0);
    };
    xhr.onload = function () {
      var r = null;
      try { r = JSON.parse(xhr.responseText || "{}"); } catch (e) { r = null; }
      if (r && r.ok) {
        setMessage("已上传：" + (r.id || f.name), "ok", 3200);
        loadAll();
      } else if (r && r.error) {
        setMessage("上传失败：" + r.error + "（HTTP " + xhr.status + "）", "err", 8000);
      } else {
        setMessage("上传失败：HTTP " + xhr.status + " " + (xhr.statusText || ""), "err", 8000);
      }
    };
    xhr.onerror = function () {
      setMessage("上传失败：网络中断（宿主可能已退出）", "err", 8000);
    };
    xhr.send(f);
  }

  // ---------------- 外观预设 ----------------
  // 预设是「一套观感」的快照（颜色/透明度/模糊/特效这些外观键）。
  // 边界由宿主 presets.mjs 的 presetKeys() 决定 —— 面板不自己判断哪些键算外观，
  // 只负责把宿主给的清单画出来。这样以后加字段不用改两处。

  var undoTimer = 0;

  function presets() {
    return Array.isArray(state.presets) ? state.presets : [];
  }

  function findPreset(id) {
    var list = presets();
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }

  /** 相对时间：今天只显示时分，其余显示日期。预设列表里 16 个「我的观感」全靠这个分辨。 */
  function fmtTime(ms) {
    // savedAt 有两种来源：宿主写入的毫秒数，以及导入 JSON 里人写的日期串。
    // 老代码直接 Number(ms)，日期串一律 NaN → 返回空串，于是列表里留下
    // 「49 键 · 」这种断尾。两种都收。
    if (ms === null || ms === undefined || ms === "") return "";
    var raw = String(ms).trim();
    var d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
    if (isNaN(d.getTime())) return "";
    if (isNaN(d.getTime())) return "";
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return "今天 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  }

  /** 保存后把焦点移到新那一行：列表可能有二十条，不跳过去等于没保存成功。 */
  function focusPreset(id) {
    if (!id) return;
    state.appliedId = id;
    state.tab = "preset";
    paint(true);
    var row = S.body && S.body.querySelector('[data-pid="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
    setTimeout(function () { row.classList.remove("flash"); }, 1200);
  }

  /** 把当前外观存成新预设。 */
  function savePreset() {
    var name = "我的观感 " + new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    postJson("/presets", { name: name }).then(function (r) {
      if (!(r && r.ok)) { setMessage("保存失败：" + ((r && r.error) || "未知"), "err", 6000); return; }
      var saved = (r.preset && r.preset.name) || name;
      var id = r.preset && r.preset.id;
      setMessage("已保存「" + saved + "」", "ok", 3200);
      return loadAll().then(function () { focusPreset(id); });
    }).catch(function (e) {
      setMessage("保存失败：" + (e && e.message || e), "err", 6000);
    });
  }

  /** 应用一套预设：宿主 updateConfig + 推 payload，页面立刻变。 */
  function applyPreset(id) {
    var p = findPreset(id);
    postJson("/presets/" + encodeURIComponent(id) + "/apply", {}).then(function (r) {
      if (!(r && r.ok)) { setMessage("应用失败：" + ((r && r.error) || "未知"), "err", 6000); return; }
      if (r.config) state.cfg = r.config;
      state.appliedId = id;
      applyGlass();
      applyScheme();
      setMessage("已应用「" + ((p && p.name) || id) + "」", "ok", 2600);
      paint(true);
    }).catch(function (e) {
      setMessage("应用失败：" + (e && e.message || e), "err", 6000);
    });
  }

  /**
   * 删除一套预设。
   *
   * 老版本一点即删、没有确认、没有后悔药 —— 这是「预设丢了」的第三条来源
   * （前两条是重启后清单没落盘、以及同名互相覆盖）。
   * 现在：删之前先把整份 doc 导出来留在内存里，页脚给 12 秒撤销窗口。
   */
  function deletePreset(id) {
    var p = findPreset(id);
    var name = (p && p.name) || id;
    getJson("/presets/" + encodeURIComponent(id) + "/export").catch(function () { return null; }).then(function (doc) {
      return fetch(api("/presets/" + encodeURIComponent(id)), { method: "DELETE" })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          if (!(r && r.ok)) { setMessage("删除失败：" + ((r && r.error) || "未知"), "err", 6000); return; }
          state.undo = { name: name, doc: (doc && (doc.preset || doc.values)) ? (doc.preset || doc) : null, at: Date.now() };
          if (undoTimer) clearTimeout(undoTimer);
          undoTimer = setTimeout(function () { undoTimer = 0; state.undo = null; syncStatus(); }, 12000);
          setMessage("已删除「" + name + "」", "ok", 6000);
          syncStatus();
          return loadAll();
        });
    }).catch(function (e) {
      setMessage("删除失败：" + (e && e.message || e), "err", 6000);
    });
  }

  function undoDelete() {
    var u = state.undo;
    if (!u) return;
    state.undo = null;
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = 0; }
    if (!u.doc) { setMessage("删除已生效，但这套预设没有可回填的内容", "err", 5000); syncStatus(); return; }
    postJson("/presets/import", { preset: u.doc, name: u.name, apply: false }).then(function (r) {
      if (r && r.ok) {
        setMessage(r.existing ? "这套观感还在「" + ((r.preset && r.preset.name) || u.name) + "」里，已指向它" : "已恢复「" + u.name + "」", "ok", 3400);
        return loadAll();
      }
      setMessage("恢复失败：" + ((r && r.error) || "未知"), "err", 6000);
      syncStatus();
    }).catch(function (e) {
      setMessage("恢复失败：" + (e && e.message || e), "err", 6000);
      syncStatus();
    });
  }

  /** 行内改名。空名/同名直接放弃，不打扰宿主。 */
  function commitRename(id, value) {
    var name = String(value || "").trim();
    var p = findPreset(id);
    var old = (p && p.name) || "";
    state.renaming = "";
    if (!name || name === old) { paint(true); return; }
    postJson("/presets/" + encodeURIComponent(id) + "/rename", { name: name }).then(function (r) {
      if (!(r && r.ok)) { setMessage("改名失败：" + ((r && r.error) || "未知"), "err", 6000); paint(true); return; }
      setMessage("已改名为「" + name + "」", "ok", 2400);
      return loadAll();
    }).catch(function (e) {
      setMessage("改名失败：" + (e && e.message || e), "err", 6000);
      paint(true);
    });
  }

  /** 导出 = 让浏览器下载一个 JSON。宿主已经设了 attachment 头。 */
  function exportPreset(id) {
    var a = document.createElement("a");
    a.href = api("/presets/" + encodeURIComponent(id) + "/export");
    a.download = "cwe-preset-" + id + ".json";
    a.style.display = "none";
    root.appendChild(a);
    a.click();
    setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
    setMessage("已导出 " + id + ".json", "ok", 2400);
  }

  /** 导入：读本地 JSON → POST /presets/import（宿主 sanitize 后才落盘）。 */
  function importPresetFile(file) {
    if (!file) return;
    file.text().then(function (txt) {
      var doc;
      try { doc = JSON.parse(txt); } catch (e) {
        setMessage("不是合法 JSON", "err", 5000);
        return;
      }
      return postJson("/presets/import", { preset: doc, name: file.name.replace(/\.json$/i, ""), apply: true })
        .then(function (r) {
          if (r && r.ok) {
            var nm = (r.preset && r.preset.name) || "预设";
            var tail = (r.ignoredKeys && r.ignoredKeys.length ? "，忽略 " + r.ignoredKeys.length + " 个非外观键" : "");
            // 宿主按「归一化后的观感」查重：同一个文件导第二次不会再落一条新预设。
            setMessage(r.existing ? "库里已有这套观感「" + nm + "」，已直接指向它" + tail : "已导入「" + nm + "」" + tail, "ok", 3600);
            return loadAll();
          }
          setMessage("导入失败：" + ((r && r.error) || "未知"), "err", 6000);
        });
    }).catch(function (e) {
      setMessage("导入失败：" + (e && e.message || e), "err", 6000);
    });
  }

  // ---------------- DOM 骨架 ----------------

  var host = null, root = null, card = null;

  function ensureHost() {
    if (!host || !document.documentElement.contains(host)) {
      host = document.getElementById(HOST_ID);
      if (!host) {
        host = document.createElement("div");
        host.id = HOST_ID;
      }
      if (!host.parentNode) (document.body || document.documentElement).appendChild(host);
      root = host.shadowRoot || host.attachShadow({ mode: "open" });
    }
    reparentIfNeeded();
  }

  /**
   * backdrop-filter 有两种静默失效，都跟「玻璃本身写得对不对」无关：
   *   a) 任一祖先带 transform / filter / perspective，那一层就成了 fixed 的包含块，
   *      同时玻璃只在没有变换上下文的层上采样 —— 面板会退化成一块死色；
   *   b) 挂在有 overflow:hidden 的容器里会被裁掉。
   * Codex 主区在侧栏动画期间会挂 transform。所以每次开面板前重判一次住处：
   * 有变换上下文就挂 documentElement，否则回 body。判错也只是退化成实色，不会崩。
   */
  function reparentIfNeeded() {
    if (!host) return;
    var target = document.body || document.documentElement;
    try {
      var b = document.body;
      if (b) {
        var cs = getComputedStyle(b);
        if ((cs.transform && cs.transform !== "none") ||
            (cs.filter && cs.filter !== "none") ||
            (cs.perspective && cs.perspective !== "none")) {
          target = document.documentElement;
        }
      }
    } catch (e) { /* 读不到就留在 body */ }
    if (host.parentNode !== target) target.appendChild(host);
  }

  // 视觉层。
  // 面板的底色/模糊不吃写死的 rgba —— --ga / --gb 由 applyGlass() 按
  // settingsWindowTransparency / settingsWindowBlur 写入，改滑块当场就变。
  var CSS = ":host { all: initial; }\n:host {\n  --fg: var(--host-fg, #f5f5f5);\n  --fg2: var(--host-fg2, rgba(255,255,255,.66));\n  --fg3: var(--host-fg3, rgba(255,255,255,.46));\n  --line: rgba(255,255,255,.10);\n  --field: rgba(255,255,255,.055);\n  --hover: rgba(255,255,255,.065);\n  --on: rgba(255,255,255,.105);\n  --base: 24,24,24;\n  --accent: #ffffff;\n  --accent-ink: #202020;\n  --danger: #ff807a;\n  --font-ui: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"Noto Sans SC\", system-ui, sans-serif;\n  --radius: 12px;\n  color-scheme: dark;\n}\n:host([data-scheme=\"light\"]) {\n  --fg: var(--host-fg, #242424);\n  --fg2: var(--host-fg2, rgba(0,0,0,.62));\n  --fg3: var(--host-fg3, rgba(0,0,0,.45));\n  --line: rgba(0,0,0,.11);\n  --field: rgba(0,0,0,.045);\n  --hover: rgba(0,0,0,.045);\n  --on: rgba(0,0,0,.07);\n  --base: 246,246,246;\n  --accent: #242424;\n  --accent-ink: #ffffff;\n  --danger: #b42318;\n  color-scheme: light;\n}\n*, *::before, *::after { box-sizing: border-box; font-family: var(--font-ui); }\nbutton, input, select { font: inherit; }\nbutton { -webkit-tap-highlight-color: transparent; }\nbutton:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {\n  outline: 2px solid var(--fg2); outline-offset: 2px;\n}\n[hidden] { display: none !important; }\n.wrap { position: fixed; inset: 0; z-index: 2147483000; display: flex;\n  opacity: 0; visibility: hidden; pointer-events: none;\n  transition: opacity 150ms cubic-bezier(.2,.8,.2,1), visibility 0s linear 150ms; }\n.wrap[data-open=\"1\"] { opacity: 1; visibility: visible; pointer-events: auto;\n  transition: opacity 150ms cubic-bezier(.2,.8,.2,1); }\n.scrim { position: absolute; inset: 0; background: rgba(0,0,0,.20); }\n.card { position: relative; margin: auto; display: flex; overflow: hidden;\n  width: min(768px, calc(100vw - 48px)); height: min(700px, calc(100vh - 56px)); height: min(700px, calc(100dvh - 56px)); font-size: var(--font-size, 13px); line-height: 1.6;\n  min-height: min(520px, calc(100vh - 32px));\n  border-radius: var(--radius); color: var(--fg);\n  background: rgba(var(--base), var(--ga, .88));\n  backdrop-filter: blur(var(--gb,18px)) saturate(1.25) brightness(1.02);\n  -webkit-backdrop-filter: blur(var(--gb,18px)) saturate(1.25) brightness(1.02);\n  border: 1px solid var(--line);\n  box-shadow: 0 18px 48px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.14), inset 0 1px 0 rgba(255,255,255,.06);\n  transform: translateY(6px);\n  transition: transform 200ms cubic-bezier(.22,1,.36,1), background 150ms; }\n.wrap[data-open=\"1\"] .card { transform: none; }\n.card[data-thin=\"1\"] .body { background: rgba(var(--base), .26); }\n.card[data-thin=\"1\"] .nav { background: rgba(var(--base), .26); }\n@supports not (aspect-ratio: 16 / 10) {\n  .tile { height: 0; padding-bottom: 62.5%; }\n  .tile .hit, .tile .del, .tile .lbl, .tile .typ, .tile .check { position: absolute; }\n}\n@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {\n  .card { background: rgb(var(--base)); }\n}\n@media (prefers-reduced-transparency: reduce) {\n  .card { background: rgb(var(--base)); backdrop-filter: none; -webkit-backdrop-filter: none; }\n  .card[data-thin=\"1\"] .body { background: transparent; }\n}\n@media (forced-colors: active) {\n  .card, .btn, .chip, .tile, .drop, .search, select, input { border: 1px solid CanvasText; }\n  .card { background: Canvas; color: CanvasText; box-shadow: none; }\n  .item[data-on=\"1\"], .chip[data-on=\"1\"] { color: Highlight; background: transparent; }\n}\n.nav { width: 158px; flex: none; display: flex; flex-direction: column; position: relative;\n  background: rgba(127,127,127,.045); border-right: 1px solid var(--line); }\n.brand { height: 46px; display: flex; align-items: center; padding: 0 14px; }\n.brand .t { font-size: 13px; font-weight: 600; letter-spacing: 0; }\n.brand .s { display: none; }\n.navlist { flex: 1; min-height: 0; overflow: auto; padding: 0 9px 12px; }\n.navlist::-webkit-scrollbar { width: 0; }\n.navgroup { padding: 14px 9px 4px; color: var(--fg3); font-size: 11px; line-height: 18px; font-weight: 500; letter-spacing: .03em; }\n.item { display: flex; align-items: center; gap: 9px; height: 32px; padding: 0 10px;\n  border: 0; width: 100%; border-radius: 7px; background: transparent; color: var(--fg2);\n  font-size: var(--font-size, 13px); cursor: default; text-align: left;\n  transition: background 120ms, color 120ms; }\n.item:hover { background: var(--hover); color: var(--fg); }\n.item[data-on=\"1\"] { background: var(--on); color: var(--fg); font-weight: 500; box-shadow: inset 2px 0 0 var(--accent); }\n.item svg { width: 17px; height: 17px; flex: none; opacity: .88; }\n.navft { padding: 6px; border-top: 1px solid var(--line); }\n.main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }\n.hdr { height: 48px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 13px 0 16px; border-bottom: 1px solid var(--line); }\n.hdr .h1 { font-size: 16px; font-weight: 600; line-height: 22px; letter-spacing: 0; }\n.hdr .h2:empty { display: none; }\n.spacer { flex: 1; }\n.searchwrap { position: relative; display: flex; align-items: center; }\n.searchwrap svg { position: absolute; left: 9px; width: 14px; height: 14px; color: var(--fg3); pointer-events: none; }\n.search { width: 152px; height: 30px; border-radius: 7px; border: 1px solid transparent;\n  background: var(--field); color: var(--fg); font-size: 12px; padding: 0 10px 0 29px; outline: none; }\n.search:hover { border-color: var(--line); }\n.search:focus { border-color: var(--fg3); background: var(--hover); }\n.search::placeholder { color: var(--fg3); }\n.x { width: 30px; height: 30px; flex: none; border-radius: 7px; border: 0; cursor: default;\n  color: var(--fg2); background: transparent; display: grid; place-items: center; }\n.x svg { width: 16px; height: 16px; }\n.x:hover { background: var(--hover); color: var(--fg); }\n.body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain;\n  scrollbar-gutter: stable; padding: 14px 17px 15px; display: flex; flex-direction: column; gap: 14px; }\n.body::-webkit-scrollbar { width: 8px; }\n.body::-webkit-scrollbar-thumb { background: rgba(128,128,128,.30); border-radius: 4px;\n  border: 2px solid transparent; background-clip: content-box; }\n.body::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,.50); background-clip: content-box; }\n.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px 10px; }\n.tile { position: relative; overflow: hidden; aspect-ratio: 16/10;\n  background: var(--field) center/cover no-repeat; border: 1px solid var(--line); border-radius: 8px;\n  color: #fff; transition: border-color 120ms, box-shadow 120ms; }\n.tile .hit { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; padding: 0;\n  /* 装饰层不吃点击：标签、类型角标、勾选圈都只是说明 */\n  pointer-events: none;\n  background: transparent; cursor: default; }\n.tile .hit { pointer-events: auto; }\n.tile .hit:focus-visible { outline: 2px solid #fff; outline-offset: -3px; }\n.tile .del { z-index: 2; position: absolute; right: 6px; top: 6px; width: 22px; height: 22px; padding: 0;\n  border: 0; border-radius: 6px; display: grid; place-items: center; color: #fff;\n  background: rgba(0,0,0,.5); opacity: 0; cursor: default; transition: opacity 120ms, background 120ms; }\n.tile:hover .del, .tile:focus-within .del, .tile .del:focus-visible { opacity: 1; }\n.tile .del:hover { background: rgba(206,58,50,.94); }\n.tile .del svg { width: 13px; height: 13px; }\n.tile:hover, .tile:focus-within { border-color: rgba(255,255,255,.42); }\n.tile[data-on=\"1\"] { border-color: transparent; box-shadow: 0 0 0 2px var(--accent); }\n.tile .lbl { pointer-events: none; position: absolute; inset: auto 0 0 0; padding: 22px 30px 8px 10px; font-size: 12px; opacity: 0; transition: opacity 120ms;\n  color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.68));\n  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .tile:hover .lbl, .tile:focus-within .lbl, .tile[data-on=\"1\"] .lbl { opacity: 1; } .tile .typ:empty { display: none; }\n.tile .typ { pointer-events: none; position: absolute; top: 7px; left: 7px; font-size: 10px; padding: 2px 5px;\n  border-radius: 4px; background: rgba(0,0,0,.54); color: rgba(255,255,255,.85); }\n.tile .check { pointer-events: none; display: none; position: absolute; right: 7px; bottom: 7px; width: 18px; height: 18px;\n  border-radius: 50%; background: #fff; color: #202020; place-items: center; }\n.tile[data-on=\"1\"] .check { display: grid; }\n.tile .check svg { width: 12px; height: 12px; }\n.settings { border-top: 1px solid var(--line); }\n.row { display: flex; align-items: center; gap: 14px; padding: 6px 2px 7px; min-height: 34px; border-bottom: 1px solid var(--line); }\n.row:last-child { border-bottom: 0; }\n.row:hover, .row:focus-within { background: var(--hover); }\n.row.flash { animation: cweflash 1.1s ease-out; }\n@keyframes cweflash { 0%, 40% { background: var(--on); } 100% { background: transparent; } }\n.row .k { width: 128px; flex: none; font-size: 13px; color: var(--fg); line-height: 19px; overflow-wrap: anywhere; }\n.row .k small { display: block; font-size: 11px; color: var(--fg3); margin-top: 2px; }\n.row .v { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }\n.row .n { width: 48px; flex: none; margin-left: auto; text-align: right; font-size: 12px; color: var(--fg2);\n  font-variant-numeric: tabular-nums; }\ninput[type=range] { -webkit-appearance: none; appearance: none; flex: 1 1 auto; width: auto; min-width: 0; max-width: 340px; height: 22px;\n  background: transparent; outline: none; cursor: default; margin: 0; }\ninput[type=range]::-webkit-slider-runnable-track { height: 3px; border-radius: 3px; background: var(--line); }\ninput[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5.5px;\n  border-radius: 50%; background: var(--fg); border: 0; cursor: default;\n  box-shadow: 0 1px 3px rgba(0,0,0,.20); }\ninput[type=range]::-moz-range-track { height: 3px; border-radius: 3px; background: var(--line); }\ninput[type=range]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--fg); }\nselect, input[type=text], input[type=number] { background: var(--field); color: var(--fg);\n  border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; font-size: 12px;\n  outline: none; width: 100%; min-height: 30px; }\nselect:focus, input[type=text]:focus { border-color: var(--fg3); }\ninput[type=color] { -webkit-appearance: none; width: 36px; height: 26px; padding: 2px;\n  border: 1px solid var(--line); border-radius: 6px; background: var(--field); cursor: default; }\ninput[type=color]::-webkit-color-swatch-wrapper { padding: 0; }\ninput[type=color]::-webkit-color-swatch { border: 0; border-radius: 3px; }\n.sw { position: relative; width: 30px; height: 17px; border-radius: 10px; border: 0; padding: 0;\n  background: rgba(128,128,128,.36); cursor: default; transition: background 140ms; flex: none; }\n.sw[data-on=\"1\"] { background: var(--fg); }\n.sw i { position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;\n  background: var(--base); transition: transform 140ms; box-shadow: 0 1px 2px rgba(0,0,0,.18); }\n.sw[data-on=\"1\"] i { transform: translateX(13px); background: var(--accent-ink); }\n.ftr { flex: none; display: flex; align-items: center; gap: 10px; padding: 7px 17px; border-top: 1px solid var(--line); font-size: 11px; color: var(--fg3); min-height: 30px; }\n.ftr .msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.ftr .msg[data-tone=\"err\"] { color: var(--danger); }\n.ftr .msg[data-tone=\"ok\"] { color: var(--fg2); }\n.ftr .msg:empty::before { content: \"已同步\"; }\n.btn { border: 1px solid var(--line); cursor: default; padding: 6px 11px; border-radius: 7px; font-size: 12px;\n  background: var(--field); color: var(--fg); min-height: 30px; }\n.btn:hover { background: var(--on); }\n.btn:active { transform: translateY(1px); }\n.btn.primary { background: var(--fg); color: var(--base); border-color: transparent; font-weight: 550; }\n.btn.ghost { background: transparent; border-color: transparent; color: var(--fg2); }\n.btn.ghost:hover { background: var(--hover); color: var(--fg); }\n.btn.sm { padding: 4px 9px; min-height: 28px; font-size: 12px; border-radius: 6px; }\n.btn.danger { color: var(--danger); }\n.btn:disabled { opacity: .45; cursor: default; }\n.iconbtn { width: 28px; padding: 0; display: inline-grid; place-items: center; }\n.iconbtn svg { width: 15px; height: 15px; }\n.toolbar { display: flex; align-items: center; gap: 8px; }\n.drop { border: 1px dashed var(--line); border-radius: 8px; padding: 7px 12px;\n  text-align: center; font-size: 12px; color: var(--fg2); cursor: default;\n  transition: border-color 120ms, color 120ms, background 120ms; }\n.drop:hover, .drop[data-over=\"1\"] { border-color: var(--fg3); color: var(--fg); background: var(--hover); }\n.note { font-size: 12px; color: var(--fg3); line-height: 1.7; }\n.empty { padding: 32px 20px; text-align: center; font-size: 13px; color: var(--fg3); line-height: 1.7; }\n.alert { border: 1px solid var(--line); border-left: 2px solid var(--danger); background: var(--field);\n  border-radius: 7px; padding: 10px 12px; font-size: 12px; color: var(--fg); line-height: 1.65; }\n.alert code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }\n.alert .ops { display: flex; gap: 8px; margin-top: 10px; }\n.sect { display: flex; align-items: center; gap: 8px; min-height: 22px; margin-top: 0; font-size: 12px;\n  color: var(--fg2); font-weight: 500; }\n.sub2 { font-size: 11px; color: var(--fg3); font-weight: 400; }\n.chips { display: flex; flex-wrap: wrap; gap: 7px; }\n.chip { border: 1px solid var(--line); border-radius: 7px; padding: 6px 11px; font-size: 12.5px;\n  color: var(--fg2); background: transparent; cursor: default; max-width: 100%;\n  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.chip:hover { background: var(--hover); color: var(--fg); }\n.chip[data-on=\"1\"] { background: var(--on); color: var(--fg); border-color: var(--fg3); font-weight: 500; }\n.chip .tag { color: var(--fg3); font-size: 11px; margin-left: 5px; font-weight: 400; }\n.segment { padding: 2px; display: inline-flex; border: 1px solid var(--line); border-radius: 8px; background: var(--field); gap: 2px; }\n.segment .chip { border: 0; min-width: 84px; }\n.segment .chip[data-on=\"1\"] { background: var(--on); box-shadow: 0 1px 3px rgba(0,0,0,.14); border-color: transparent; }\n.faces { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }\n.face { border: 1px solid var(--line); border-radius: 8px; background: var(--field); padding: 8px; display: grid; grid-template-columns: 72px minmax(0, 1fr); grid-template-areas: \"pv cap\" \"pv ops\"; gap: 3px 10px; align-items: center; min-width: 0; }\n.face .pv { grid-area: pv; width: 72px; aspect-ratio: 16/9; border-radius: 5px; background: rgba(0,0,0,.16) center/contain no-repeat; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--fg3); }\n.face .cap { grid-area: cap; font-size: 12px; line-height: 16px; color: var(--fg2); }\n.face .ops { grid-area: ops; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-start; }\n.prow { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 2px;\n  border-bottom: 1px solid var(--line); }\n.prow:last-child { border-bottom: 0; }\n.prow[data-cur=\"1\"] .pn::before { content: \"\"; display: inline-block; width: 5px; height: 5px;\n  border-radius: 50%; background: var(--fg); margin: 0 8px 2px 0; }\n.prow .pn { flex: 1; min-width: 0; font-size: 13px; }\n.prow .pn small { display: block; font-size: 11px; color: var(--fg3); margin-top: 3px; }\n.prow .pn .pk { display: block; font-style: normal; font-size: 11px; color: var(--fg3); margin-top: 2px;\n  font-variant-numeric: tabular-nums; }\n.prow .po { display: flex; gap: 3px; flex: none; opacity: 0; transition: opacity 120ms; }\n.prow:hover .po, .prow:focus-within .po, .prow[data-cur=\"1\"] .po { opacity: 1; }\n.prow input.rename { width: 230px; }\n.prow button.pn { background: none; border: 0; padding: 0; text-align: left; color: var(--fg); cursor: default; font: inherit; }\n.prow button.pn:hover .pname { text-decoration: underline; text-underline-offset: 3px; }\n.plist { display: flex; flex-direction: column; border-top: 1px solid var(--line); }\n.defs { margin: 0; border-top: 1px solid var(--line); }\n.defs > div { display: grid; grid-template-columns: 128px minmax(0,1fr); gap: 14px; padding: 10px 2px; border-bottom: 1px solid var(--line); }\n.defs dt { color: var(--fg3); font-size: 12px; }\n.defs dd { margin: 0; font-size: 12px; color: var(--fg2); overflow-wrap: anywhere; }\n.defs code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }\n.launcher { position: fixed; left: 8px; bottom: 96px; z-index: 2147482999; width: 36px; height: 36px;\n  border-radius: 12.5px; border: 0; background: transparent; color: var(--fg2);\n  cursor: default; padding: 0; display: none; place-items: center;\n  transition: background 120ms, color 120ms; }\n.launcher:hover { background: var(--hover); color: var(--fg); }\n.launcher[data-show=\"1\"] { display: grid; }\n.launcher svg { display: block; width: 20px; height: 20px; }\n@media (max-width: 900px) {\n  .card { width: calc(100vw - 28px); height: calc(100vh - 28px); }\n  .nav { width: 156px; }\n  .hdr { padding-left: 18px; }\n  .body { padding: 12px 14px 13px; }\n  .row .k { width: 112px; }\n  .hdr .h2 { display: none; }\n}\n@media (max-width: 680px) {\n  .card { width: 100vw; height: 100vh; min-height: 0; border-radius: 0; border: 0; }\n  .nav { width: 124px; }\n  .brand { padding: 0 14px; }\n  .navlist { padding-left: 7px; padding-right: 7px; }\n  .item { padding: 0 8px; gap: 8px; font-size: 12px; }\n  .navgroup { padding-left: 8px; }\n  .hdr { padding: 0 10px 0 14px; gap: 6px; }\n  .hdr .h1 { font-size: 15px; }\n  .search { width: 34px; padding-left: 29px; color: transparent; }\n  .search::placeholder { color: transparent; }\n  .search:focus { position: absolute; right: 36px; width: min(210px, calc(100vw - 190px)); color: var(--fg); z-index: 3; background: rgb(var(--base)); }\n  .search:focus::placeholder { color: var(--fg3); }\n  .body { padding: 11px; }\n  .row { align-items: flex-start; flex-direction: column; gap: 5px; padding: 10px 0; }\n  .row .k { width: 100%; }\n  .row .v { width: 100%; }\n  .grid { grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px 8px; }\n  .tile .del { opacity: 1; }\n  .faces { grid-template-columns: 1fr; }\n  .prow { flex-wrap: wrap; }\n  .prow .po { opacity: 1; }\n  .segment { display: flex; }\n  .segment .chip { min-width: 0; flex: 1; }\n  .defs > div { grid-template-columns: 100px minmax(0,1fr); }\n}\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation: none !important; transition: none !important; }\n}";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // hint：搜索命中时，把「它属于哪一组」写进 label 下面那行 —— 搜索结果每一条都得
  // 自己交代出处，否则用户看到一个「模糊 8px」不知道该跳到哪。
  // 第二参只能显式传：Array.prototype.map 会把 index 当 hint 塞进来，
  // 所以所有列表调用点一律走 fieldsHtml()。
  function fieldHtml(f, hint) {
    var v = state.cfg ? state.cfg[f.key] : undefined;
    // tip：补一句只在悬停时出现的说明。标签一旦被括号注到第二行，整行就比邻居高一截，
    // 竖排看过去像断了一格 —— 所以说明走 title，不占版面。
    var k = esc(f.key), label = esc(f.label || f.key), tip = f.tip ? ' title="' + esc(f.tip) + '"' : "";
    var row = '<div class="row" data-field="' + k + '"><div class="k"' + tip + ">" + label +
              (hint ? "<small>" + esc(hint) + "</small>" : "") + "</div><div class=\"v\">";
    if (f.type === "range") {
      var step = f.step != null ? f.step : 1;
      row += '<input type="range" aria-label="' + label + '" data-key="' + k + '" min="' + f.min + '" max="' + f.max + '" step="' + step +
             '" value="' + (v == null ? f.min : v) + '">';
      row += '<div class="n">' + (v == null ? "" : esc(v)) + esc(f.unit || "") + "</div>";
    } else if (f.type === "select") {
      row += '<select data-key="' + k + '">';
      (f.options || []).forEach(function (o) {
        row += '<option value="' + esc(o) + '"' + (String(v) === String(o) ? " selected" : "") + ">" + esc(o) + "</option>";
      });
      row += "</select>";
    } else if (f.type === "toggle") {
      row += '<button type="button" class="sw" role="switch" aria-label="' + label + '" aria-checked="' + (v ? "true" : "false") + '" data-key="' + k + '" data-on="' + (v ? 1 : 0) + '"><i></i></button>';
    } else if (f.type === "color") {
      row += '<input type="color" data-key="' + k + '" value="' + esc(v || "#ffffff") + '">';
      row += '<div class="n">' + esc(v || "") + "</div>";
    } else {
      row += '<input type="text" data-key="' + k + '" value="' + esc(v == null ? "" : v) + '">';
    }
    return row + "</div></div>";
  }

  /** 一组字段的 HTML。存在的唯一理由是别让 map 把 index 传成 hint。 */
  function fieldsHtml(g) {
    var fs = (g && g.fields) || [];
    var out = [];
    for (var i = 0; i < fs.length; i++) out.push(fieldHtml(fs[i]));
    return out.join("");
  }

  // ---------------- 轮播 tab ----------------
  function rotationTab() {
    var inv = state.inv;
    var list = groups();
    var act = activeGroup();
    var html = "";

    // 顶部：开关 + 进度 + 导入
    var on = state.cfg && state.cfg.rotationEnabled;
    var rot = (CWE.state && CWE.state.rotation) || null;
    html += '<div class="sect"><span>轮换</span><span class="spacer"></span>' +
            '<span class="sub2">' + (on ? (rot && rot.candidates ? rot.candidates + " 张候选" : "已开启") : "已关闭") + "</span></div>";
    html += '<div class="settings"><div class="row"><div class="k">自动更换壁纸</div><div class="v">' +
            '<button type="button" class="sw" role="switch" aria-label="自动更换壁纸" aria-checked="' + !!on + '" data-key="rotationEnabled" data-on="' + (on ? 1 : 0) + '"><i></i></button></div></div>';

    // 组列表
    html += '<div class="sect"><span>轮播列表</span><span class="spacer"></span>' +
            '<button class="btn sm" data-act="grp-new">新建</button></div>';
    if (!list.length) {
      html += '<div class="empty">还没有轮播列表 —— 点「新建」，再从下面把壁纸加进来</div>';
    } else {
      html += '<div class="chips">';
      list.forEach(function (g) {
        var isAct = act && act.id === g.id;
        var n = Array.isArray(g.wallpaperIds) ? g.wallpaperIds.length : 0;
        html += '<button type="button" class="chip" data-grp="' + esc(g.id) + '" data-on="' + (isAct ? 1 : 0) + '">' +
                esc(g.name || g.id) + '<span class="tag">' + n + " 张</span></button>";
      });
      html += "</div>";
    }

    if (act) {
      html += '<div class="sect"><span>' + esc(act.name || act.id) + '</span><span class="spacer"></span>' +
              '<button class="btn sm" data-grp-del="' + esc(act.id) + '">删除这一组</button></div>';
      html += '<div class="row"><div class="k">间隔（分钟）</div><div class="v">' +
              '<input type="range" data-gf="interval" min="1" max="240" step="1" aria-label="轮换间隔（分钟）" value="' + esc(act.interval || 30) + '">' +
              '<div class="n">' + esc(act.interval || 30) + " 分钟</div></div></div></div>";
      html += '<div class="row"><div class="k">顺序</div><div class="v"><select data-gf="order">' +
              '<option value="sequence"' + (act.order !== "random" ? " selected" : "") + ">顺序</option>" +
              '<option value="random"' + (act.order === "random" ? " selected" : "") + ">随机</option></select></div></div>";
      html += '<div class="row"><div class="k">推进方式</div><div class="v"><select data-gf="trigger">' +
              '<option value="interval"' + (act.trigger !== "videoEnd" ? " selected" : "") + ">按间隔</option>" +
              '<option value="videoEnd"' + (act.trigger === "videoEnd" ? " selected" : "") + ">视频播完就换</option></select></div></div>";

      // 成员：整个清单，点一下加入/移出
      html += '<div class="sect"><span>成员</span><span class="spacer"></span><span class="sub2">点一下加入 / 移出</span></div>';
      var all = (inv && inv.wallpapers) || [];
      if (!all.length) {
        html += '<div class="empty">清单还没就绪</div>';
      } else {
        var members = {};
        (act.wallpaperIds || []).forEach(function (id) { members[id] = 1; });
        html += '<div class="chips">';
        all.forEach(function (w) {
          var on2 = members[w.id] ? 1 : 0;
          html += '<button type="button" class="chip" aria-pressed="' + !!on2 + '" data-gm="' + esc(w.id) + '" data-on="' + on2 + '">' + esc(w.title || w.id) + "</button>";
        });
        html += "</div>";
      }
    }

    return html;
  }

  function wallpaperTab() {
    var inv = state.inv;
    var html = "";
    if (!inv) return '<div class="empty">清单还没就绪</div>';
    var list = (inv.wallpapers || []).filter(function (w) { return !w.hidden; });
    var cur = state.cfg && state.cfg.id;
    html += '<div class="grid">';
    if (!list.length) {
      html += '<div class="empty">没有可用壁纸 —— 拖入一张图片，或用 cwe upload</div>';
    }
    list.forEach(function (w) {
      var bg = w.preview ? "background-image:url('" + api("/preview/" + String(w.preview).split("/").pop()) + "')" : "";
      // 一个格子里放两个按钮：整块是「用它」，右上角是「删它」。
      // 不能写成 button 套 button（HTML 解析会把内层甩出去），所以外层用 div，
      // 选中按钮是铺满的 .hit，删除按钮压在它上面。
      html += '<div class="tile" data-on="' + (w.id === cur ? 1 : 0) + '" style="' + bg + '">' +
              '<button type="button" class="hit" data-id="' + esc(w.id) + '" aria-label="使用壁纸 ' + esc(w.title || w.id) + '" aria-pressed="' + (w.id === cur) + '"></button>' +
              '<span class="typ">' + (w.type === "video" ? "视频" : "") + "</span>" +
              '<span class="check">' + icon("check") + '</span>' +
              '<span class="lbl">' + esc(w.title || w.id) + "</span>" +
              '<button type="button" class="del" data-tile-del="' + esc(w.id) + '" title="删除这张壁纸" aria-label="删除 ' + esc(w.title || w.id) + '">' + icon("trash") + "</button>" +
              "</div>";
    });
    html += "</div>";
    html += '<div class="drop" data-act="upload">把图片或视频拖到这里（或点击选择）</div>';
    var g = state.groups.filter(function (x) { return x.id === "wallpaper"; })[0];
    if (g) html += '<div class="settings">' + fieldsHtml(g) + "</div>";
    return html;
  }

  function genericTab(id) {
    var g = state.groups.filter(function (x) { return x.id === id; })[0];
    if (!g) return '<div class="empty">没有这一组</div>';
    var html = "";
    // 玻璃这一组尤其需要档位：两个滑杆分别是「多透」和「多糊」，
    // 它们不是独立变量 —— 透到 50 以下才看得见壁纸，糊到 18px 才读得稳。
    // 让用户自己对表碰参数，等于把一个设计问题推给使用者。
    if (id === "glass") {
      var cfg0 = state.cfg || {};
      var tr0 = typeof cfg0.settingsWindowTransparency === "number" ? cfg0.settingsWindowTransparency : 74;
      var cur0 = glassTier(tr0);
      html += '<div class="sect"><span>设置面板</span></div>';
      html += '<div class="chips segment" role="group" aria-label="面板材质">';
      ["thin", "std", "solid"].forEach(function (k) {
        var t0 = GLASS_TIERS[k];
        html += '<button class="chip" data-glass="' + k + '" data-on="' + (k === cur0 ? 1 : 0) + '">' +
          t0.label + '<span class="tag">' + t0.tr + "% / " + t0.bl + "px</span></button>";
      });
      html += "</div>";

    }
    return html + '<div class="settings">' + fieldsHtml(g) + "</div>";
  }

  /** 一张资源卡的 HTML。has 决定给「上传」还是「替换 / 清除」。 */
  function faceCard(title, path, has, accept) {
    var bg = has ? "background-image:url('" + api(path) + "?v=" + Date.now().toString(36) + "')" : "";
    return '<div class="face">' +
      '<div class="pv" style="' + bg + '">' + (has ? "" : "未设置") + "</div>" +
      '<div class="cap">' + esc(title) + "</div>" +
      '<div class="ops">' +
        '<button class="btn" data-img="' + esc(path) + '" data-accept="' + esc(accept) + '">' + (has ? "替换" : "上传") + "</button>" +
        (has ? '<button class="btn" data-imgdel="' + esc(path) + '">清除</button>' : "") +
      "</div></div>";
  }

  function mascotTab() {
    var html = '<div class="sect">吉祥物与头像</div><div class="faces">' +
      faceCard("吉祥物", "/mascot", state.has.mascot, "image/*") +
      faceCard("用户头像", "/avatar/user", state.has.user, "image/*") +
      faceCard("AI 头像", "/avatar/ai", state.has.ai, "image/*") +
      "</div>";
    html += '<div class="note">图片上限 8MB，支持 JPG / PNG / WebP。文件名由宿主铸造，替换即时生效。</div>';
    html += genericTab("mascot");
    return html;
  }

  function fontTab() {
    var cfg = state.cfg || {};
    var cur = cfg.fontSetId || "";
    var html = '<div class="sect">字体集</div><div class="chips">';
    if (!state.fontsets.length) html += '<span class="note">还没有字体集</span>';
    state.fontsets.forEach(function (s) {
      html += '<button class="chip" data-font="' + esc(s.id) + '" data-on="' + (s.id === cur ? 1 : 0) + '">' +
        esc(s.name || s.id) + '<span class="tag">' + esc(s.source === "builtin" ? "随包" : "自定义") + "</span></button>";
    });
    html += "</div>";
    html += '<div class="sect"><span>系统字体</span><span class="spacer"></span><span class="sub2">' +
            (state.fontsLoading ? "读取中…" : (state.sysFonts ? state.sysFonts.length + " 个" : "未加载")) + "</span></div>";
    if (state.fontsErr) {
      html += '<div class="alert">上次读取失败：' + esc(state.fontsErr) +
              '<div class="ops"><button class="btn sm" data-act="loadfonts">重试</button></div></div>';
    }
    if (state.fontsLoading) {
      html += '<div class="note">正在读系统字体，第一次要几秒 —— 宿主在跑系统字体清单命令。</div>';
    } else if (state.sysFonts === null) {
      html += '<div class="chips"><button class="btn sm" data-act="loadfonts">加载系统字体</button></div>';
    } else if (!state.sysFonts.length) {
      html += '<div class="note">这台机器没扫到系统字体（精简系统 / 容器里常见）。界面字体仍可用随包字体集。</div>';
    } else {
      html += '<div class="chips">';
      state.sysFonts.slice(0, 48).forEach(function (name) {
        html += '<button class="chip" data-family="' + esc(name) + '" title="' + esc(name) + '">' + esc(name) + "</button>";
      });
      html += "</div>";
      if (state.sysFonts.length > 48) html += '<div class="note">只显示前 48 个，共 ' + state.sysFonts.length + " 个。点一个就把界面字体换成它。</div>";
    }
    html += genericTab("font");
    return html;
  }

  /**
   * 外观预设 tab。
   *
   * 旧版是「chips 一组 + 管理 row 一组」：同一套预设出现两次，chips 那半用的是
   * data-preset —— 而 onClick 里没有这个分支，点了完全没反应。另外没有改名、
   * 看不出当前是哪一套、读失败时直接显示「还没有预设」。
   *
   * 现在一行一套：
   *   左：名字（button，点一下就是应用）+ 元信息（随包/键数/保存时间）
   *   右：应用 · 改名 · 导出 · 删除（悬停显形，当前那一行常显）
   * 改名是行内 input：Enter 提交，Esc 放弃。
   * 读失败单独一块 alert，带重试和磁盘路径 ——「读不到」和「一套都没有」必须分得开。
   */
  function presetTab() {
    var list = presets();
    var html = "";

    html += '<div class="sect"><span>外观预设</span><span class="spacer"></span>' +
            '<span class="sub2">' + (state.presetKeys.length ? "外观设置" : "点名称应用") + "</span></div>";
    html += '<div class="toolbar">' +
              '<button class="btn sm primary" data-act="preset-save">保存当前设置</button>' +
              '<button class="btn sm" data-act="preset-import">导入</button>' +
            "</div>";

    if (state.presetError) {
      html += '<div class="alert">' + esc(state.presetError) +
              '<div class="ops"><button class="btn sm" data-act="preset-retry">重试</button></div>' +
              (state.presetDir ? '<div class="note">预设目录 <code>' + esc(state.presetDir) + "</code></div>" : "") +
              '<div class="note">连接恢复后可以重试，已保存的文件仍保留在原位置。</div></div>';
    }

    if (!list.length) {
      if (!state.presetError) {
        html += '<div class="empty">还没有预设。<br>调好外观后点「保存当前设置」，下次继续使用。</div>';
      }
    } else {
      html += '<div class="sect"><span>' + list.length + ' 套</span><span class="spacer"></span>' +
              '<span class="sub2">点名称应用</span></div>';
      html += '<div class="plist">';
      for (var i = 0; i < list.length; i++) html += presetRow(list[i]);
      html += "</div>";
    }

    html += '<div class="note">预设包含画面、界面和字体设置，不会改变壁纸文件、端口或数据目录。</div>';
    return html;
  }

  /**
   * 把宿主给的 peek 四项压成一行小字。
   *
   * 只用来「认」，不用来「算」：缺项就跳过，缺光就整行不出现 —— 老预设里没有
   * 这些键也不会冒出「undefined%」。
   */
  function peekLine(p) {
    if (!p) return "";
    var bits = [];
    if (typeof p.wallpaperOpacity === "number") bits.push("壁纸 " + Math.round(p.wallpaperOpacity) + "%");
    if (typeof p.wallpaperBlur === "number") bits.push("模糊 " + Math.round(p.wallpaperBlur) + "px");
    if (typeof p.backgroundBrightness === "number") bits.push("亮 " + Math.round(p.backgroundBrightness) + "%");
    if (typeof p.backgroundContrast === "number") bits.push("对比 " + Math.round(p.backgroundContrast) + "%");
    return bits.join(" · ");
  }

  /** 一行预设。data-pid 给 focusPreset 定位；data-cur 标最后一次应用的那一套。 */
  function presetRow(s) {
    var id = esc(s.id);
    var cur = s.id === state.appliedId;
    var meta = s.builtin ? "随包内置" : ((s.keys || 0) + " 键" + (s.savedAt ? " · " + fmtTime(s.savedAt) : ""));
    var html = '<div class="prow" data-pid="' + id + '" data-cur="' + (cur ? "1" : "0") + '">';

    if (s.id === state.renaming) {
      html += '<input class="rename" type="text" data-rn="' + id + '" value="' + esc(s.name || s.id) + '" spellcheck="false">' +
              '<span class="spacer"></span><span class="sub2">Enter 保存 · Esc 放弃</span>';
      return html + "</div>";
    }

    var pk = peekLine(s.peek);
    html += '<button class="pn" data-preset-apply="' + id + '" title="应用这套观感">' +
            '<span class="pname">' + esc(s.name || s.id) + "</span><small>" + esc(meta) + "</small>" +
            (pk ? '<em class="pk">' + esc(pk) + "</em>" : "") + "</button>" +
            '<span class="spacer"></span><span class="po">' +
            '<button class="btn sm" data-preset-apply="' + id + '">应用</button>' +
            (s.builtin ? "" : '<button class="btn sm iconbtn" title="重命名" aria-label="重命名 ' + esc(s.name || id) + '" data-preset-rename="' + id + '">' + icon("edit") + '</button>') +
            '<button class="btn sm iconbtn" title="导出" aria-label="导出 ' + esc(s.name || id) + '" data-preset-export="' + id + '">' + icon("download") + '</button>' +
            (s.builtin ? "" : '<button class="btn sm iconbtn danger" title="删除" aria-label="删除 ' + esc(s.name || id) + '" data-preset-del="' + id + '">' + icon("trash") + '</button>') +
            "</span>";
    return html + "</div>";
  }

  // ---------------- 系统字体 ----------------
  // 这个函数原来写在 render 段里，整段 splice 掉之后 runAct 的 loadfonts 就成了
  // 「调一个不存在的函数」：点按钮静默抛错，界面毫无反应。补回来，并做实三件事：
  //   1) 失败留错误、能重试，不是永远停在「未加载」；
  //   2) 扫描要几秒（宿主首次要跑系统清单命令），期间显示「读取中」并挡住重复点击；
  //   3) 空清单不等于失败 —— 有些机器就是扫不到，也要给一句人话。
  function loadSystemFonts() {
    if (state.fontsLoading) return;
    state.fontsLoading = true;
    state.fontsErr = "";
    syncStatus();
    if (state.tab === "font") paint(true);
    getJson("/system-fonts?refresh=1")
      .then(function (r) {
        if (r && r.ok === false) throw new Error(r.error || "宿主读取失败");
        var list = (r && r.fonts) || [];
        if (!Array.isArray(list)) throw new Error("返回里没有 fonts 数组");
        state.sysFonts = list.filter(function (x) { return typeof x === "string" && x.trim(); });
        state.fontsAt = Date.now();
        setMessage(state.sysFonts.length ? "读到 " + state.sysFonts.length + " 个字体" : "这台机器没扫到字体", "ok", 3000);
      })
      .catch(function (e) {
        state.fontsErr = String((e && e.message) || e);
        setMessage("字体读取失败：" + state.fontsErr, "err", 6000);
      })
      .then(function () {
        state.fontsLoading = false;
        syncStatus();
        if (state.tab === "font") paint(true);
      });
  }

  function hostTab() {
    var inv = state.inv || {};
    var st = CWE.report ? CWE.report() : {};
    var html = genericTab("host");
    html += '<dl class="defs">' +
      '<div><dt>连接</dt><dd>' + (base() ? "本机服务已连接" : "尚未连接") + '</dd></div>' +
      '<div><dt>壁纸</dt><dd>' + esc(inv.total == null ? "-" : inv.total) + " 项</dd></div>" +
      '<div><dt>页面</dt><dd>' + (st.mounted ? "已挂载" : "未挂载") + " · " + esc(st.kind || "无") + '</dd></div>' +
      '<div><dt>数据目录</dt><dd><code>' + esc(state.dataRoot || inv.dataRoot || "-") + '</code></dd></div>' +
      '<div><dt>上传目录</dt><dd><code>' + esc(inv.uploadDir || "-") + '</code></dd></div>' +
      '<div><dt>快捷键</dt><dd>⌥⌘W / Ctrl+Alt+W</dd></div>' +
      '</dl>';
    return html;
  }

  var TABS = [
    ["wallpaper", "壁纸"],
    ["rotation", "轮播"],
    ["preset", "预设"],
    ["glass", "玻璃与界面"],
    ["composer", "输入框"],
    ["code", "代码块"],
    ["bubble", "写作与消息"],
    ["fx", "特效"],
    ["parallax", "视差"],
    ["mascot", "头像"],
    ["font", "字体"],
    ["host", "宿主"],
  ];

  // ---------------- 骨架：mount 一次，之后只动局部 ----------------
  //
  // 0.9.x 的 render() 是 root.innerHTML = 整棵树，任何一次改动都重建。
  // 由此长出三个真问题，用户报了两个：
  //   a) .body 是新建节点，scrollTop 归零 —— 调完亮度面板跳回最上面；
  //   b) 正在拖的 input[type=range] 被替换，拖拽当场中断、滑块回弹；
  //   c) 上传进度每触发一次就 render()，几百 MB 的视频会让面板整个卡死。
  // 现在拆成三层，各自只做一件事：
  //   ensureMounted()  只建一次骨架，节点缓存在 S 里；
  //   paint()          只换 .body.innerHTML，并按 tab 记忆/恢复滚动位置；
  //   syncField()      只改一个控件 + 它的读数，拖动期间走这条，永不重建。

  function icon(name) {
    var paths = {
      wallpaper: '<rect x="3" y="3.5" width="14" height="13" rx="2"/><circle cx="7" cy="7.5" r="1.1"/><path d="m3.5 14 4-4 3 3 2.5-2.5 3.5 3.5"/>',
      rotation: '<path d="M14.8 6A6 6 0 0 0 5 5.5L3 7.5M3 3.5v4h4M5.2 14A6 6 0 0 0 15 14.5l2-2M17 16.5v-4h-4"/>',
      preset: '<path d="M4 4h12v12H4zM7 4v5h6V4M7 16v-4h6v4"/>',
      glass: '<path d="M6 3h8l3 5-7 9-7-9zM3 8h14M6 3l4 14 4-14"/>',
      composer: '<rect x="3" y="5" width="14" height="10" rx="3"/><path d="m6 10 .01 0M10 10h4"/>',
      code: '<path d="m7 5-5 5 5 5M13 5l5 5-5 5M11 3 9 17"/>',
      bubble: '<path d="M4 3h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 3v-3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM6 7h8M6 10h5"/>',
      fx: '<path d="m10 2 1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8zM16 14l.7 2.3L19 17l-2.3.7L16 20l-.7-2.3L13 17l2.3-.7z"/>',
      parallax: '<rect x="5" y="5" width="12" height="12" rx="2"/><rect x="2" y="2" width="12" height="12" rx="2"/><path d="m9 10 3 3M9 13v-3h3"/>',
      mascot: '<circle cx="10" cy="7" r="3"/><path d="M4 18c.5-4 2.5-6 6-6s5.5 2 6 6"/>',
      font: '<path d="M4 4h12M10 4v13M6 17h8M14 11l3 7M20 11l-3 7M15 16h4"/>',
      host: '<rect x="3" y="3" width="14" height="6" rx="1.5"/><rect x="3" y="11" width="14" height="6" rx="1.5"/><path d="M6 6h.01M6 14h.01M10 6h4M10 14h4"/>',
      close: '<path d="m5 5 10 10M15 5 5 15"/>',
      search: '<circle cx="8.5" cy="8.5" r="5"/><path d="m12 12 5 5"/>',
      check: '<path d="m4 10 4 4 8-8"/>',
      edit: '<path d="m4 14-.7 3.7L7 17l9-9-3-3zM11.5 6.5l3 3"/>',
      download: '<path d="M10 3v10M6 9l4 4 4-4M4 15v3h12v-3"/>',
      trash: '<path d="M3 5h14M8 5V3h4v2M5 5l1 13h8l1-13M8 8v7M12 8v7"/>'
    };
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || paths.wallpaper) + '</svg>';
  }
  var LAUNCHER_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true">' +
    '<rect x="2.6" y="3.6" width="14.8" height="12.8" rx="3.2" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
    '<circle cx="7.1" cy="7.9" r="1.35" fill="currentColor"/>' +
    '<path d="M3.6 14.1l4.2-4 2.9 2.6 2.4-2.2 3.4 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  var TAB_DESC = {
    wallpaper: "",
    rotation: "",
    preset: "",
    glass: "",
    composer: "",
    code: "",
    bubble: "",
    fx: "",
    parallax: "",
    mascot: "",
    font: "",
    host: "本机连接与数据位置",
  };
  var NAV_SECTIONS = [
    ["画面", ["wallpaper", "rotation", "preset"]],
    ["界面", ["glass", "composer", "code", "bubble"]],
    ["个性化", ["fx", "parallax", "mascot", "font"]],
    ["系统", ["host"]]
  ];

  function paintKey() { return state.query ? "$q" : state.tab; }

  function tabBody(tab) {
    if (state.query) return searchBody();
    if (tab === "wallpaper") return wallpaperTab();
    if (tab === "rotation") return rotationTab();
    if (tab === "preset") return presetTab();
    if (tab === "mascot") return mascotTab();
    if (tab === "font") return fontTab();
    if (tab === "host") return hostTab();
    return genericTab(tab);
  }

  function shellHtml() {
    var nav = NAV_SECTIONS.map(function (section) {
      return '<div class="navgroup">' + section[0] + '</div>' + section[1].map(function (id) {
        var tab = TABS.filter(function (t) { return t[0] === id; })[0];
        return '<button class="item" data-tab="' + id + '" aria-current="false">' +
          icon(id) + '<span>' + esc(tab[1]) + '</span></button>';
      }).join("");
    }).join("");
    return '<button class="launcher" data-act="open" title="壁纸设置（⌥⌘W）" aria-label="壁纸设置">' +
        LAUNCHER_SVG + "</button>" +
      '<div class="wrap" data-open="0">' +
        '<div class="scrim" data-act="close"></div>' +
        '<section class="card" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="cwe-panel-title">' +
          '<nav class="nav" aria-label="壁纸设置分类">' +
            '<div class="brand"><div class="t">外观</div><div class="s"></div></div>' +
            '<div class="navlist">' + nav + '</div>' +
            '<div class="navft"><button class="btn ghost" data-act="reset" style="width:100%">恢复默认</button></div>' +
          '</nav>' +
          '<div class="main">' +
            '<header class="hdr"><div style="min-width:0"><h1 class="h1" id="cwe-panel-title"></h1><div class="h2"></div></div>' +
              '<span class="spacer"></span>' +
              '<div class="searchwrap">' + icon("search") +
                '<input class="search" type="search" placeholder="搜索设置" aria-label="搜索设置" data-act="search">' +
              '</div>' +
              '<button class="x" data-act="close" title="关闭" aria-label="关闭壁纸设置">' + icon("close") + '</button>' +
            '</header>' +
            '<div class="body"></div>' +
            '<footer class="ftr"><span class="msg" role="status" aria-live="polite"></span><span class="spacer"></span>' +
              '<button class="btn sm" data-act="undo" hidden>撤销删除</button>' +
            '</footer>' +
          '</div>' +
        '</section>' +
      '</div>';
  }

  function ensureMounted() {
    if (!host || !document.documentElement.contains(host)) ensureHost();
    if (!host || !root) return false;
    mountNativeEntry();
    if (S.card && root.contains(S.card)) return true;
    root.innerHTML = "<style>" + CSS + "</style>" + shellHtml();
    S.wrap = root.querySelector(".wrap");
    S.card = root.querySelector(".card");
    S.body = root.querySelector(".body");
    S.h1 = root.querySelector(".hdr .h1");
    S.h2 = root.querySelector(".hdr .h2");
    S.search = root.querySelector(".search");
    S.msg = root.querySelector(".ftr .msg");
    S.undo = root.querySelector("[data-act=undo]");
    S.launcher = root.querySelector(".launcher");
    S.nav = root.querySelector(".navlist");
    S.brandSub = root.querySelector(".brand .s");
    S.title = root.querySelector(".h1");
    S.items = Array.prototype.slice.call(root.querySelectorAll(".item"));
    bindDelegates();
    applyScheme();
    applyGlass();
    // 刚被 innerHTML 重建过：新的 launcher 节点没有 inline 残值，
    // 必须按「入口挂没挂」重新算一次，否则浮球会跟着入口一起冒出来。
    syncLauncher();
    return true;
  }

  function syncNav() {
    if (!S.items) return;
    for (var i = 0; i < S.items.length; i++) {
      var on = !state.query && S.items[i].getAttribute("data-tab") === state.tab;
      S.items[i].setAttribute("data-on", on ? "1" : "0");
      S.items[i].setAttribute("aria-current", on ? "page" : "false");
    }
  }

  function syncHeader() {
    if (!S.h1) return;
    if (state.query) {
      S.h1.textContent = "搜索：" + state.query;
      S.h2.textContent = "";
      return;
    }
    var title = state.tab;
    for (var i = 0; i < TABS.length; i++) if (TABS[i][0] === state.tab) title = TABS[i][1];
    S.h1.textContent = title;
    S.h2.textContent = TAB_DESC[state.tab] || "";
  }

  function syncStatus() {
    if (!S.msg) return;
    var text = state.loading ? "读取中…" : (state.message || "");
    S.msg.textContent = text;
    S.msg.setAttribute("data-tone", state.messageTone || "");
    if (S.undo) {
      S.undo.hidden = !state.undo;
      if (state.undo) S.undo.textContent = "撤销删除「" + (state.undo.name || "") + "」";
    }
    syncLauncher();
    // 品牌区不写端口。内置设置不会把 127.0.0.1:65270 摆在标题下面 —— 那是外挂的痕迹。
    // 连接地址仍然可查，位置在「宿主」tab（hostTab 里的「宿主：…」）。
    if (S.brandSub) S.brandSub.textContent = base() ? "" : "未连接宿主";
  }

  function paint(force) {
    if (!ensureMounted()) return;
    // 拖动中禁止重建：DOM 一换，用户手里那根滑块就没了。
    if (state.dragging) { state.pendingPaint = true; return; }
    var prev = state.paintedKey;
    var wantedKey = paintKey();
    // 同一页重绘默认不做事，避免每帧重建 DOM。但「数据到了」这种刷新必须能穿透：
    // 面板第一次打开时 body 里已经有一句「读取中」的占位，paintedKey 也已经记成当前页；
    // 若这里一律早退，loadAll 回来后就永远停在占位上（壁纸页空白的主因）。
    if (!force && prev === wantedKey && S.body.childNodes.length) return;
    state.pendingPaint = false;
    if (prev && S.body) scrollMemo[prev] = S.body.scrollTop;
    var key = wantedKey;
    S.body.innerHTML = tabBody(state.tab);
    state.paintedKey = key;
    state.paintedTab = state.tab;
    // 同一个 tab 重绘（保存预设后刷新列表）时保住滚动；切 tab 时回到它自己的位置。
    var want = scrollMemo[key];
    S.body.scrollTop = typeof want === "number" ? want : 0;
    syncNav();
    syncHeader();
    syncStatus();
  }

  /** 单个控件回写。宿主钳制过的值走这里，不重画任何东西。 */
  function syncField(key) {
    if (!S.body || !key) return;
    var el = S.body.querySelector('[data-key="' + key + '"]');
    if (!el) return;
    var v = state.cfg ? state.cfg[key] : undefined;
    if (el.tagName === "SELECT") { if (v != null) el.value = String(v); return; }
    if (el.tagName === "INPUT") {
      if (el.type === "range") {
        // 用户正按着这根滑块：只刷新读数，不要把 value 抢回去。
        if (activeEl() !== el) el.value = v == null ? el.min : v;
        setNum(el, v);
        return;
      }
      if (el.type === "color") { if (v && activeEl() !== el) el.value = String(v); setNum(el, v); return; }
      if (el.type === "text") { if (activeEl() !== el) el.value = v == null ? "" : String(v); return; }
    }
    if (el.classList && el.classList.contains("sw")) { el.setAttribute("data-on", v ? 1 : 0); el.setAttribute("aria-checked", v ? "true" : "false"); }
  }

  function setNum(el, v) {
    var n = el.parentElement && el.parentElement.querySelector(".n");
    if (!n) return;
    var f = findField(el.getAttribute("data-key"));
    n.textContent = (v == null || v === "" ? "" : v) + (f && f.unit ? f.unit : "");
  }

  function activeEl() {
    try { return root.activeElement; } catch (e) { return null; }
  }

  // ---- 拖动冻结 ----
  // range 的 input 事件在拖动中每帧都来，change 在松手时来一次。
  // 松手后再留 260ms 静默期：这一小段时间里可能还有一次宿主回包要落值，
  // 提前解冻会让 paint() 正好插在「回包 → 重建」之间，还是会把滑块吞掉。
  var dragTimer = 0;
  // 用户明确点导航 / 跳字段时，原来那次拖拽就该作废：
  // 继续把它当"拖拽中"，后续 paint 会被整段跳过（点不动 + 滚动位置不记）。
  function releaseDrag() {
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = 0; }
    state.dragging = 0;
    state.pendingPaint = false;
  }

  function beginDrag() {
    state.dragging = 1;
    if (dragTimer) clearTimeout(dragTimer);
    // 兜底：并不是每次 input 都跟着一个 change —— 指针在窗口外松开、
    // 键盘微调后焦点被宿主抢走、或者拖拽中失焦，都会让 dragging 永久为 1。
    // 那之后任何切页都会在 paint() 的最前面被挡掉（看起来像「点不动」）。
    // 1.4s 没有下一次 input 就当作已经放手。
    dragTimer = setTimeout(function () {
      dragTimer = 0;
      state.dragging = 0;
      if (state.pendingPaint) { state.pendingPaint = false; paint(); }
    }, 900);
  }
  function endDrag() {
    if (dragTimer) clearTimeout(dragTimer);
    dragTimer = setTimeout(function () {
      dragTimer = 0;
      state.dragging = 0;
      if (state.pendingPaint) { state.pendingPaint = false; paint(); }
    }, 260);
  }

  // ---- 反馈 ----
  // ttl：到点自动退回「改动即时生效」。老面板在 loadAll 里无条件清 message，
  // 于是「已保存 / 已导入」经常一个字都看不见就没了。
  var msgTimer = 0;
  function setMessage(text, tone, ttl) {
    state.message = text || "";
    state.messageTone = tone || "";
    state.messageAt = Date.now();
    if (msgTimer) { clearTimeout(msgTimer); msgTimer = 0; }
    if (ttl) {
      msgTimer = setTimeout(function () {
        msgTimer = 0;
        state.message = "";
        state.messageTone = "";
        syncStatus();
      }, ttl);
    }
    syncStatus();
  }

  // ---- 面板玻璃 ----
  // settingsWindowTransparency / settingsWindowBlur 这两个键早就写在 DEFAULTS 与 sanitize 里，
  // 但没有任何一处消费它们，GROUPS 里也没有对应字段 —— 三重断裂，面板永远是写死的
  // rgba(26,26,28,.92)。现在：滑杆 → config → 这里 → CSS 变量 → backdrop-filter 当场变。
  function applyGlass() {
    if (!S.card) return;
    var c = state.cfg || {};
    var tr = typeof c.settingsWindowTransparency === "number" ? c.settingsWindowTransparency : 86;
    var bl = typeof c.settingsWindowBlur === "number" ? c.settingsWindowBlur : 12;
    var ga = Math.max(0, Math.min(1, tr / 100));
    S.card.style.setProperty("--ga", String(Math.round(ga * 1000) / 1000));
    S.card.style.setProperty("--gb", Math.max(0, Math.min(60, Math.round(bl))) + "px");
    // 太透的时候补一层极淡的底，否则正文压在花壁纸上读不动。
    S.card.setAttribute("data-thin", ga < 0.45 ? "1" : "0");
  }

  /** 主题跟随宿主的真实令牌；页面底色常被壁纸改透明，不能拿它判明暗。 */
  function applyScheme() {
    if (!host) return;
    var scheme = "dark";
    var de = document.documentElement;
    try {
      var hint = String(de.getAttribute("data-theme") || de.getAttribute("data-color-mode") || "").toLowerCase();
      if (hint === "system") hint = "";
      var cs = getComputedStyle(de);
      if (/light/.test(hint)) scheme = "light";
      else if (/dark/.test(hint)) scheme = "dark";
      else if (String(cs.colorScheme).indexOf("light") >= 0) scheme = "light";
      var read = function (names) {
        for (var i = 0; i < names.length; i++) {
          var v = cs.getPropertyValue(names[i]).trim();
          if (v && v !== "initial" && v !== "transparent" && v !== "none") return v;
        }
        return "";
      };
      var fg = read(["--color-text-primary", "--color-text", "--text-primary", "--color-foreground"]);
      var surface = read(["--color-surface", "--color-background", "--background", "--color-surface-primary"]);
      var border = read(["--color-border", "--border", "--color-border-default"]);
      var fontSize = read(["--font-ui-size", "--text-sm", "--text-control-label", "--text-base"]);
      var radius = read(["--dialog-radius", "--radius-lg", "--radius-md-base"]);
      var accent = read(["--codex-theme-accent-text", "--color-accent", "--accent", "--color-blue"]);
      host.style.setProperty("--host-fg", fg || (scheme === "light" ? "#242424" : "#f5f5f5"));
      host.style.setProperty("--host-fg2", fg ? "color-mix(in srgb, " + fg + " 65%, transparent)" : (scheme === "light" ? "rgba(0,0,0,.62)" : "rgba(255,255,255,.66)"));
      host.style.setProperty("--host-fg3", fg ? "color-mix(in srgb, " + fg + " 45%, transparent)" : (scheme === "light" ? "rgba(0,0,0,.45)" : "rgba(255,255,255,.46)"));
      if (surface) {
        var c = document.createElement("canvas"); c.width = c.height = 1;
        var ctx = c.getContext("2d"); ctx.fillStyle = surface;
        var parts = ctx.fillStyle.match(/\d+(?:\.\d+)?/g);
        if (parts && parts.length >= 3) host.style.setProperty("--base", parts.slice(0,3).join(","));
      }
      if (border) host.style.setProperty("--line", border);
      if (/calc|min|max|clamp/.test(fontSize)) {
        var probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;font-size:" + fontSize;
        de.appendChild(probe);
        fontSize = getComputedStyle(probe).fontSize;
        probe.remove();
      }
      if (/^\d+(?:\.\d+)?px$/.test(fontSize)) {
        var px = Math.max(12, Math.min(14, parseFloat(fontSize)));
        host.style.setProperty("--font-size", px + "px");
      }
      if (/^\d+(?:\.\d+)?px$/.test(radius)) host.style.setProperty("--radius", Math.max(8, Math.min(16, parseFloat(radius))) + "px");
      if (accent) {
        host.style.setProperty("--accent", accent);
        // 宿主给的强调色可能是深蓝，开关上的滑块需要一个对比色。
        try {
          var ac = document.createElement("canvas"); ac.width = ac.height = 1;
          var actx = ac.getContext("2d"); actx.fillStyle = accent;
          var ap = actx.fillStyle.match(/\d+(?:\.\d+)?/g);
          if (ap && ap.length >= 3) {
            var lum = (0.2126 * Number(ap[0]) + 0.7152 * Number(ap[1]) + 0.0722 * Number(ap[2])) / 255;
            host.style.setProperty("--accent-ink", lum > 0.62 ? "#202020" : "#ffffff");
          }
        } catch (eA) { /* 颜色解析失败时用默认白 */ }
      }
    } catch (e) { /* 宿主结构变化时仍有内置色板 */ }
    if (state.scheme !== scheme) {
      state.scheme = scheme;
      host.setAttribute("data-scheme", scheme);
    }
  }

  var themeObserver = null;
  function watchHost() {
    try {
      if (!themeObserver && typeof MutationObserver === "function") {
        themeObserver = new MutationObserver(function () { if (!state.destroyed) { applyScheme(); scheduleRelayout(); } });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode", "data-theme-variant"] });
      }
    } catch (e) { themeObserver = null; }
  }

  // ---- 导航 ----
  function goto(tab) {
    if (!tab) return;
    if (state.query) { state.query = ""; if (S.search) S.search.value = ""; }
    state.tab = tab;
    releaseDrag();
    paint();
  }

  function gotoField(key, tab) {
    state.query = "";
    if (S.search) S.search.value = "";
    if (tab) state.tab = tab;
    releaseDrag();
    paint();
    var el = S.body && S.body.querySelector('[data-key="' + key + '"]');
    var row = el && el.closest ? el.closest(".row") : null;
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("flash");
    setTimeout(function () { row.classList.remove("flash"); }, 1200);
  }

  /** 跨全部分组搜字段：150 个键靠翻 tab 找不到，搜索是刚需。 */
  function searchBody() {
    var q = String(state.query || "").toLowerCase();
    var hits = [];
    var seen = {};
    for (var i = 0; i < state.groups.length; i++) {
      var g = state.groups[i] || {};
      var fs = g.fields || [];
      for (var j = 0; j < fs.length; j++) {
        var f = fs[j];
        if (!f || !f.key || seen[f.key]) continue;
        var hay = ((f.label || "") + " " + f.key + " " + (g.title || g.id || "")).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
        seen[f.key] = 1;
        hits.push({ g: g, f: f });
      }
    }
    if (!hits.length) {
      return '<div class="empty">没有匹配「' + esc(state.query) + "」的设置项。<br>试试「亮度」「模糊」「字体」「玻璃」。</div>";
    }
    var html = '<div class="sect"><span>' + hits.length + " 个结果</span></div>";
    hits.forEach(function (h) {
      html += '<div data-goto="' + esc(h.f.key) + '" data-gtab="' + esc(h.g.id) + '">' +
              fieldHtml(h.f, h.g.title || h.g.id) + "</div>";
    });
    return html;
  }

  function launcherShown() {
    var cfg = state.cfg;
    if (!cfg) return true;
    return cfg.cweLauncher !== false;
  }

  // 原生入口到底挂上没有。navEntry 是缓存，DOM 查询是事实 —— 两者取或，
  // 因为旧实例可能留下一个活着的入口而 navEntry 还没接上。
  function entryMounted() {
    if (navEntry && navEntry.parentNode && document.documentElement.contains(navEntry)) return true;
    return !!document.querySelector('[data-cwe-entry="wallpaper"]');
  }

  /**
   * 浮球和原生入口是同一件事的两个形态，绝不能同时出现。
   *
   * 踩过的坑（真机）：侧栏上出现两个壁纸图标 —— 上面是浮球 launcher（fixed, top 658），
   * 下面是克隆出来的原生入口（y 702），纵向挨着 44px。用户一眼就是「插件坏了」。
   *
   * 为什么会这样：mountNativeEntry() 里那三处 display="none" 全部发生在
   * ensureMounted() 重建 #cwe-panel-host 之前；重建会把 launcher 节点换成新的、
   * inline style 清空，然后 syncStatus() 按 launcherShown() 把 data-show 写成 1 ——
   * 而 launcherShown() 只看配置，根本不看入口挂没挂。于是两边各显各的。
   *
   * 现在唯一的真相在这里：入口在，浮球就必须彻底消失；入口不在（nav 还没渲染、
   * 克隆失败），浮球才是兜底入口。
   */
  function launcherVisible() {
    if (state.open) return false;
    if (!launcherShown()) return false;
    if (entryMounted()) return false;
    return !!S.launcher;
  }

  // 唯一改浮球显隐的入口：data-show 管 CSS，inline display 交回去（别留残值），
  // 真的可见时才去算坐标。
  function syncLauncher() {
    var lb = S.launcher;
    if (!lb) return;
    var on = launcherVisible();
    lb.setAttribute("data-show", on ? "1" : "0");
    lb.style.display = "";
    if (on) positionLauncher();
  }

  /**
   * 把浮球钉到侧栏底部「使用情况」按钮的正上方，并且跟那一列像素级对齐。
   *
   * 为什么不能写死坐标：侧栏高度随窗口变，底部那一叠（使用情况按钮 + 头像按钮）
   * 是 Codex 自己的布局，硬写 bottom 会撞到头像 —— 真机撞过一次，用户直接看见了。
   * 所以每次渲染/窗口变化都按实测位置重算。
   *
   * ★ 锚点必须是「按钮盒子」，不是里面那个 svg。
   *   踩过的坑：早期拿额度环 svg 的 rect 当锚点（svg 在 36px 按钮里居中，左右各留 4px），
   *   于是浮球整体右移 4px、尺寸还是 30×30、跟上面的间距只有 4px —— 肉眼就是「没对齐」。
   *   现在一律取 svg.closest('button') 的 rect，浮球尺寸/圆角/左边界全部跟着按钮走。
   *
   * 兜底 = aside 找不到（侧栏折叠）时回到左下方，bottom 96px 仍然按
   *        8(视口) + 36(头像) + 8(gap) + 36(用量) + 8(gap) 算出来。
   */
  function positionLauncher() {
    var lb = S.launcher;
    if (!lb) return;
    var anchor = null;
    var aside = document.querySelector("nav[data-app-navigation-rail='true'], nav[aria-label='应用导航'], aside[class*='app-shell-left-panel']");
    if (aside) {
      var h = window.innerHeight || 800;
      aside.querySelectorAll("svg").forEach(function (s) {
        var r = s.getBoundingClientRect();
        if (r.width < 16 || r.height < 16) return;          // 忽略小图标
        if (r.left > 60) return;                            // 只要侧栏最左侧那一列
        if (r.top < h * 0.55 || r.bottom > h + 1) return;   // 只要视口下半部分
        var btn = s.closest("button");                      // 锚点用按钮盒子，不用 svg
        var b = (btn || s).getBoundingClientRect();
        if (b.width < 24 || b.height < 24) return;
        if (!anchor || b.top < anchor.top) anchor = b;      // 取最上面那个 = 使用情况按钮
      });
    }
    if (anchor) {
      var w = Math.round(anchor.width);
      var hh = Math.round(anchor.height);
      lb.style.width = w + "px";
      lb.style.height = hh + "px";
      // 原生按钮圆角 12.5px / 36px ≈ 34.7%；按比例跟，尺寸变了也不走样
      lb.style.borderRadius = (Math.round(w * 0.347 * 10) / 10) + "px";
      lb.style.left = Math.round(anchor.left) + "px";
      lb.style.top = Math.round(Math.max(8, anchor.top - 8 - hh)) + "px";
      lb.style.bottom = "auto";
    } else {
      lb.style.width = "36px";
      lb.style.height = "36px";
      lb.style.borderRadius = "12.5px";
      lb.style.left = "8px";
      lb.style.top = "auto";
      lb.style.bottom = "96px";
    }
  }

  var navEntry = null;
  var navResizeObserver = null;

  /**
   * 把入口按钮摆到「侧栏最底部那一叠（用量 + 头像）的正上方」。
   *
   * 真机结构（Codex 157）：
   *   nav[data-app-navigation-rail]   display:flex; flex-direction:column; gap:8px; align-items:center
   *   ├─ div.group/nav-list …        ← 六项导航
   *   └─ div.relative.shrink-0.w-9   ← 底部那一叠的唯一 direct child
   *      └─ div.flex.flex-col.gap-2
   *         ├─ div > button[aria-label=用量]
   *         └─ div.flex.w-full > button[aria-label=打开个人资料菜单]
   *
   * 踩过的坑：早先「从头像按钮往上爬，找到第一个 flex column 就插在它前面」——
   * 那个 column 正是「用量 + 头像」那一列本身，于是按钮被插进列里变成第三格，
   * 视觉上掉到「用量」下面。列里的位置还取决于插入时机（先插在用量前 → 用量上，
   * 后插在 w-full 前 → 用量下），所以每次重挂都可能换位置。
   *
   * 正确做法：一路爬到「父节点就是 nav」的那一层（= 底部那一叠），插在它前面。
   * 这样位置只由结构决定，重挂多少次都落在同一个地方：nav 的最后一个孩子之前、
   * 用量按钮上方 8px（nav 自己的 gap）。
   */
  function placeEntry(nav, b) {
    if (!nav || !b) return false;
    var profile = Array.prototype.slice.call(nav.querySelectorAll("button")).filter(function (x) {
      return /个人资料|profile/i.test(x.getAttribute("aria-label") || "") && x !== b;
    }).pop();
    var stack = profile;
    while (stack && stack.parentNode && stack.parentNode !== nav) stack = stack.parentNode;
    if (stack && stack.parentNode === nav) {
      if (b.parentNode !== nav || b.nextSibling !== stack) nav.insertBefore(b, stack);
      return true;
    }
    var source = nav.querySelector("button[data-sidebar-destination]");
    if (source && source.parentNode) {
      if (b.parentNode !== source.parentNode || b.nextSibling !== source) source.parentNode.insertBefore(b, source);
      return true;
    }
    if (b.parentNode !== nav) nav.appendChild(b);
    return true;
  }

  /**
   * 侧栏里只允许存在一个壁纸入口。
   *
   * 踩过的坑（真机）：出现过两个 —— y=658 与 y=702 并排，两个都带 data-cwe-entry，
   * 都被 placeEntry() 插在底部那一叠前面，父节点都是 nav。不是浮球，是真的两个克隆。
   *
   * 怎么来的：被顶替的旧实例，它自己的 MutationObserver 在「发现自己已被顶替」之前
   * 还会再挂一次入口，于是多出一个。而新实例的 bootEntry() 一看到 navEntry 已在 DOM
   * 里就直接 return true —— mountNativeEntry() 里那段去重代码根本没机会跑，
   * 除非用户手动打开一次面板（ensureMounted 才会调它）。所以那个多余入口会一直留着。
   *
   * 现在把「只留一个」提成独立动作，自举路径和看管路径都会走到它。
   */
  function reconcileEntries() {
    var all = Array.prototype.slice.call(document.querySelectorAll('[data-cwe-entry="wallpaper"]'));
    if (all.length <= 1) return all[0] || null;
    var keep = (navEntry && all.indexOf(navEntry) >= 0) ? navEntry : all[0];
    for (var i = 0; i < all.length; i++) {
      if (all[i] === keep) continue;
      try { all[i].remove(); } catch (e) {}
    }
    // ★ 必须把 navEntry 指向留下来的那个。
    // 踩过的坑（真机，两次）：只删不认领，navEntry 就可能指向刚被删掉的节点；
    // 紧接着 nav 上的 MutationObserver 发现「navEntry 不在 nav 里」→ mountNativeEntry()
    // 走克隆分支，把入口又造一个回来 —— 删一个、加一个，来回拉锯，永远收敛不到 1 个。
    navEntry = keep;
    return keep;
  }

  function mountNativeEntry() {
    var nav = document.querySelector('nav[data-app-navigation-rail="true"], nav[aria-label="应用导航"]');
    reconcileEntries();
    if (navEntry && document.documentElement.contains(navEntry) && nav && nav.contains(navEntry)) {
      // 位置不对就重摆一次（旧实例留下的位置可能停在「用量」下面）。
      placeEntry(nav, navEntry);
      syncLauncher();
      return;
    }
    if (nav && !navEntry) {
      var oldEntries = nav.querySelectorAll('[data-cwe-entry="wallpaper"]');
      if (oldEntries.length) {
        navEntry = oldEntries[0];
        for (var oi = 1; oi < oldEntries.length; oi++) oldEntries[oi].remove();
        placeEntry(nav, navEntry);
        syncLauncher();
        return;
      }
    }
    if (navEntry && navEntry.parentNode) navEntry.parentNode.removeChild(navEntry);
    navEntry = null;
    var source = nav && nav.querySelector("button[data-sidebar-destination]");
    if (source) {
      try {
        var b = source.cloneNode(true);
        for (var ai = 0; ai < b.attributes.length; ai++) {
          var an = b.attributes[ai].name;
          if (an === "id" || an === "name" || an === "value" || an.indexOf("data-") === 0 || an.indexOf("aria-") === 0) b.removeAttribute(an);
        }
        b.setAttribute("data-cwe-entry", "wallpaper");
        b.setAttribute("aria-label", "壁纸设置");
        b.setAttribute("title", "壁纸设置");
        b.style.borderRadius = "12.5px";
        b.style.backgroundColor = "transparent";
        b.style.opacity = "1";
        b.style.width = "36px";
        b.style.height = "36px";
        b.style.flex = "none";
        var svg = b.querySelector("svg");
        if (svg && svg.parentNode) {
          var box = document.createElement("span");
          box.innerHTML = icon("wallpaper");
          svg.parentNode.replaceChild(box.firstChild, svg);
        }
        var sr = b.querySelector(".sr-only");
        if (sr) sr.textContent = "壁纸设置";
        b.addEventListener("click", function (ev) {
          ev.preventDefault(); ev.stopPropagation(); toggle();
        });
        placeEntry(nav, b);
        navEntry = b;
        state.mountedEntry = true;
        syncLauncher();
        if (navResizeObserver) { try { navResizeObserver.disconnect(); } catch (e) {} }
        if (typeof MutationObserver === "function") {
          navResizeObserver = new MutationObserver(function () {
            if (CWE.panel && CWE.panel.__inst && CWE.panel.__inst !== INSTANCE) { try { navResizeObserver.disconnect(); } catch (eG) {} navResizeObserver = null; return; }
            if (!state.destroyed && (!navEntry || !nav.contains(navEntry))) mountNativeEntry();
          });
          navResizeObserver.observe(nav, { childList: true, subtree: true });
        }
        return;
      } catch (e) { navEntry = null; }
    }
    // 挂不上（nav 还没渲染、克隆失败）才让浮球出场 —— 这是唯一的兜底路径。
    syncLauncher();
  }

  /**
   * 注入完就把入口挂上 —— 不要等用户先开一次面板。
   *
   * 踩过的坑：入口只在 ensureMounted()（openPanel 才走）里挂。页面重载 / Codex 重开后，
   * runtime 和面板都在，可侧栏那个壁纸图标一个都没有 —— 用户看不到入口，只能判断
   * 「插件挂了」。真机复现：Page.reload 后 entry 连续 30 秒都是 false。
   *
   * 所以独立于面板做一次自举：nav 一出现就挂；nav 还没渲染出来就短轮询等到它出现
   * （Codex 启动时侧栏是异步挂载的）。挂上之后交给已有的 MutationObserver 看管。
   */
  var bootTimer = 0;
  // 兜底心跳：旧实例的观察器最多能再塞一个进来，塞完它自己就断开了。
  // 这里每 1.5s 收敛一次，不必等用户开面板。
  var entrySweep = 0;
  function startEntrySweep() {
    if (entrySweep || state.destroyed) return;
    entrySweep = setInterval(function () {
      if (state.destroyed) { clearInterval(entrySweep); entrySweep = 0; return; }
      if (!navEntry || !navEntry.parentNode) return;
      try {
        if (document.querySelectorAll('[data-cwe-entry="wallpaper"]').length > 1) {
          reconcileEntries();
          syncLauncher();
        }
      } catch (e) {}
    }, 1500);
  }
  function bootEntry() {
    if (state.destroyed) return false;
    reconcileEntries();
    if (navEntry && navEntry.parentNode && document.documentElement.contains(navEntry)) return true;
    var nav = document.querySelector('nav[data-app-navigation-rail="true"], nav[aria-label="应用导航"]');
    if (!nav) return false;
    mountNativeEntry();
    return !!(navEntry && navEntry.parentNode);
  }
  function bootEntryWatch() {
    if (bootEntry()) return;
    if (bootTimer) return;
    var tries = 0;
    bootTimer = setInterval(function () {
      if (state.destroyed || ++tries > 40) { clearInterval(bootTimer); bootTimer = 0; return; }
      if (bootEntry()) { clearInterval(bootTimer); bootTimer = 0; }
    }, 500);
  }

  var relayouting = 0;
  function scheduleRelayout() {
    if (relayouting) return;
    relayouting = setTimeout(function () { relayouting = 0; try { positionLauncher(); } catch (e) {} }, 120);
  }
  try {
    window.addEventListener("resize", scheduleRelayout, false);
  } catch (e) { /* 忽略 */ }

  // ---------------- 事件：一次性委托在 shadow root 上 ----------------
  // 老面板每次 render() 之后重新 bind() 一遍：几十个 addEventListener，节点却被换掉了。
  // 委托之后 paint() 换多少次 innerHTML 都不用管绑定。

  var inputFile = null;
  var presetFile = null;

  function bindDelegates() {
    root.addEventListener("click", onClick, false);
    root.addEventListener("input", onInput, false);
    root.addEventListener("change", onChange, false);
    root.addEventListener("keydown", onKeyDown, false);
    root.addEventListener("dragover", onDragOver, false);
    root.addEventListener("dragleave", onDragLeave, false);
    root.addEventListener("drop", onDrop, false);
  }

  function closestAttr(node, attr) {
    var el = node;
    while (el && el !== root) {
      if (el.getAttribute && el.getAttribute(attr) != null) return el;
      el = el.parentNode;
    }
    return null;
  }

  function onClick(e) {
    var t = e.target;
    if (!t) return;

    // 开关。<button class="sw" data-key> 的点击原本无人接手 —— 所有 toggle 字段
    // 只能看不能拨，用户说的「这些开关全部都没有用」就是这条断链。
    // 必须排在 data-key 的其它消费者之前，且只认 BUTTON：滑块/取色器/文本框
    // 身上也有 data-key，点它们不该当成拨开关。
    var sw = closestAttr(t, "data-key");
    if (sw && sw.tagName === "BUTTON" && sw.classList && sw.classList.contains("sw")) {
      var swKey = sw.getAttribute("data-key");
      var swOn = !(state.cfg && state.cfg[swKey]);
      // 先乐观上屏：等宿主回包再校正的话，用户会觉得「点了半天没反应」。
      sw.setAttribute("data-on", swOn ? 1 : 0);
      sw.setAttribute("aria-checked", swOn ? "true" : "false");
      patch(swKey, swOn);
      // 打开玻璃时，若这块玻璃的两个量都停在 0，开关本身没有任何可见效果
      // （颜色 mix 出来是 0%，blur 是 0px）。这时候替用户把两个滑块推到常规位置，
      // 否则「拨了没反应」这件事会一直成立。
      if (swOn) {
        var c0 = state.cfg || {};
        if (swKey === "titlebarGlass" && Number(c0.titlebarTransparency) === 0 && Number(c0.titlebarBlur) === 0) {
          patch("titlebarTransparency", 86);
          patch("titlebarBlur", 18);
        }
        if (swKey === "rightSidebarGlass" && Number(c0.rightSidebarTransparency) === 0 && Number(c0.rightSidebarBlur) === 0) {
          patch("rightSidebarTransparency", 84);
          patch("rightSidebarBlur", 20);
        }
      }
      return;
    }

    var el = closestAttr(t, "data-tab");
    if (el) { goto(el.getAttribute("data-tab")); return; }

    el = closestAttr(t, "data-act");
    if (el) { runAct(el.getAttribute("data-act"), el, e); return; }

    el = closestAttr(t, "data-goto");
    if (el) { gotoField(el.getAttribute("data-goto"), el.getAttribute("data-gtab")); return; }

    // 删除按钮落在 tile 里面，.hit 也带 data-id —— 这个分支必须排在 data-id 之前，
    // 否则点删除会先被 pick() 吞掉，变成「只是切过去了」。
    el = closestAttr(t, "data-tile-del");
    if (el) { removeWallpaper(el.getAttribute("data-tile-del")); return; }

    el = closestAttr(t, "data-id");
    if (el) { pick(el.getAttribute("data-id")); return; }

    el = closestAttr(t, "data-grp");
    if (el) { patch("rotationGroupId", el.getAttribute("data-grp")); paint(); return; }

    el = closestAttr(t, "data-grp-del");
    if (el) { deleteGroup(el.getAttribute("data-grp-del")); return; }

    el = closestAttr(t, "data-gm");
    if (el) {
      var act = activeGroup();
      if (act) toggleMember(act.id, el.getAttribute("data-gm"));
      return;
    }

    el = closestAttr(t, "data-img");
    if (el) {
      var path = el.getAttribute("data-img");
      openPicker(el.getAttribute("data-accept") || "image/*", function (file) { uploadImage(path, file); });
      return;
    }
    el = closestAttr(t, "data-imgdel");
    if (el) { deleteImage(el.getAttribute("data-imgdel")); return; }

    el = closestAttr(t, "data-glass");
    if (el) { runGlassPreset(el.getAttribute("data-glass")); return; }

    el = closestAttr(t, "data-font");
    if (el) { patch("fontSetId", el.getAttribute("data-font")); return; }

    el = closestAttr(t, "data-family");
    if (el) {
      var fam = el.getAttribute("data-family");
      var next = Object.assign({}, (state.cfg && state.cfg.themeFamily) || {});
      next.ui = fam;
      patch("themeFamily", next);
      return;
    }

    el = closestAttr(t, "data-preset-apply");
    if (el) { applyPreset(el.getAttribute("data-preset-apply")); return; }
    el = closestAttr(t, "data-preset-export");
    if (el) { exportPreset(el.getAttribute("data-preset-export")); return; }
    el = closestAttr(t, "data-preset-del");
    if (el) { deletePreset(el.getAttribute("data-preset-del")); return; }
    el = closestAttr(t, "data-preset-rename");
    if (el) {
      state.renaming = el.getAttribute("data-preset-rename");
      paint();
      var ri = S.body && S.body.querySelector("input.rename");
      if (ri) { try { ri.focus(); ri.select(); } catch (e2) { /* 只聚焦也行 */ } }
      return;
    }
  }

  // 三档是同一块玻璃的三种厚度。滑杆仍保留 —— 档位负责「一眼像原生」，
  // 滑杆负责「我知道自己在调什么」。
  var GLASS_TIERS = {
    thin: { tr: 46, bl: 26, label: "通透" },
    std: { tr: 74, bl: 18, label: "标准" },
    solid: { tr: 94, bl: 10, label: "厚实" }
  };

  function glassTier(tr) {
    if (tr <= 55) return "thin";
    if (tr >= 88) return "solid";
    return "std";
  }

  function runGlassPreset(name) {
    var t = GLASS_TIERS[name];
    if (!t) return;
    patchMany({ settingsWindowTransparency: t.tr, settingsWindowBlur: t.bl });
    var cur = glassTier(t.tr);
    if (S.body) {
      var chips = S.body.querySelectorAll("[data-glass]");
      for (var i = 0; i < chips.length; i++) {
        chips[i].setAttribute("data-on", chips[i].getAttribute("data-glass") === cur ? "1" : "0");
      }
    }
    setMessage("已切到" + t.label + "：" + t.tr + "% · " + t.bl + "px", "", 2600);
  }

  function runAct(act, el, e) {
    if (!act) return;
    if (act === "close") { closePanel(); return; }
    if (act === "open") { if (e) e.stopPropagation(); openPanel(); return; }
    if (act === "preset-retry") { setMessage("正在重读预设…", "", 3000); loadAll(); return; }
    if (act === "reset") { reset(); return; }
    if (act === "undo") { undoDelete(); return; }
    if (act === "grp-new") { createGroup(); return; }
    if (act === "preset-save") { savePreset(); return; }
    if (act === "preset-import") {
      if (!presetFile) {
        presetFile = document.createElement("input");
        presetFile.type = "file";
        presetFile.accept = "application/json,.json";
        presetFile.style.display = "none";
        root.appendChild(presetFile);
        presetFile.addEventListener("change", function () {
          var f = presetFile.files && presetFile.files[0];
          presetFile.value = "";
          if (f) importPresetFile(f);
        });
      }
      presetFile.click();
      return;
    }
    if (act === "loadfonts") { loadSystemFonts(); return; }
    if (act === "upload") {
      if (!inputFile) {
        inputFile = document.createElement("input");
        inputFile.type = "file";
        inputFile.accept = "image/*,video/mp4,video/webm";
        inputFile.style.display = "none";
        root.appendChild(inputFile);
        inputFile.addEventListener("change", function () {
          var files = inputFile.files;
          inputFile.value = "";
          upload(files);
        });
      }
      inputFile.click();
    }
  }

  function onInput(e) {
    var t = e.target;
    if (!t) return;
    if (t.classList && t.classList.contains("search")) {
      state.query = String(t.value || "").trim();
      paint();
      return;
    }
    if (t.tagName !== "INPUT") return;
    if (t.type === "range") {
      var gf = t.getAttribute("data-gf");
      if (gf) {
        var n0 = t.parentElement && t.parentElement.querySelector(".n");
        if (n0) n0.textContent = t.value + " min";
        beginDrag();
        return;
      }
      var key = t.getAttribute("data-key");
      if (!key) return;
      beginDrag();
      setNum(t, t.value);
      patch(key, Number(t.value));
      return;
    }
    if (t.type === "color") {
      var k2 = t.getAttribute("data-key");
      if (!k2) return;
      setNum(t, t.value);
      patch(k2, t.value);
    }
  }

  function onChange(e) {
    var t = e.target;
    if (!t) return;
    var rn = t.getAttribute && t.getAttribute("data-rn");
    if (rn) { commitRename(rn, t.value); return; }
    if (t.tagName === "SELECT") {
      var gf = t.getAttribute("data-gf");
      if (gf) {
        var a = activeGroup();
        if (a) updateGroup(a.id, gf, t.value);
        return;
      }
      var key = t.getAttribute("data-key");
      if (key) patch(key, t.value);
      return;
    }
    if (t.tagName === "INPUT") {
      if (t.type === "range") { endDrag(); return; }
      if (t.type === "text") {
        var k3 = t.getAttribute("data-key");
        if (k3) patch(k3, t.value);
      }
    }
  }

  /**
   * Tab 在面板里打转。
   * 原生模态框不会把焦点漏到底下的编辑器里去 —— 漏出去之后下一次 Tab 会跑进 Codex
   * 正文，用户以为面板卡了。这里让 Tab 在卡片内部循环，首尾相接。
   * 只收「看得见且没禁用」的控件：隐藏的撤销按钮、data-show=0 的浮球本来就不该被 Tab 撞到。
   */
  function trapTab(e) {
    if (!state.open || e.key !== "Tab" || !S.card) return;
    var nodes = S.card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || n.disabled) continue;
      if (n.hidden || n.getAttribute("aria-hidden") === "true") continue;
      var r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      list.push(n);
    }
    if (!list.length) { e.preventDefault(); try { S.card.focus({ preventScroll: true }); } catch (err) {} return; }
    var first = list[0];
    var last = list[list.length - 1];
    var cur = activeEl();
    if (!e.shiftKey && cur === last) { e.preventDefault(); try { first.focus({ preventScroll: true }); } catch (err) {} }
    else if (e.shiftKey && (cur === first || cur === S.card || !cur)) { e.preventDefault(); try { last.focus({ preventScroll: true }); } catch (err) {} }
  }

  function onKeyDown(e) {
    var t = e.target;
    if (e.key === "Tab") { trapTab(e); return; }
    var rn = t && t.getAttribute && t.getAttribute("data-rn");
    if (rn) {
      if (e.key === "Enter") { e.preventDefault(); t.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); state.renaming = ""; paint(); }
      return;
    }
    if (t && t.classList && t.classList.contains("search") && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (state.query) { state.query = ""; t.value = ""; paint(); }
      return;
    }
  }

  function onDragOver(e) {
    if (!e.dataTransfer) return;
    var files = e.dataTransfer.types;
    if (!files) return;
    e.preventDefault();
    var d = S.body && S.body.querySelector(".drop");
    if (d) d.setAttribute("data-over", "1");
  }
  function onDragLeave() {
    var d = S.body && S.body.querySelector(".drop");
    if (d) d.removeAttribute("data-over");
  }
  function onDrop(e) {
    var d = S.body && S.body.querySelector(".drop");
    if (d) d.removeAttribute("data-over");
    if (!e.dataTransfer) return;
    var fl = e.dataTransfer.files;
    if (!fl || !fl.length) return;
    e.preventDefault();
    if (!state.open) return;
    upload(fl);
  }

  function findField(key) {
    for (var i = 0; i < state.groups.length; i++) {
      var fs = state.groups[i].fields || [];
      for (var j = 0; j < fs.length; j++) if (fs[j].key === key) return fs[j];
    }
    return null;
  }

  /**
   * 打开面板。
   *
   * 旧 show() 走 render() —— 整块 innerHTML 重写。那等于「一开面板就重挂一棵树」：
   * 滚动位置、搜索词、动效全部回到初始状态。现在只切一个属性，树不动：
   * data-open 由 CSS 负责淡入与缩放，paint() 只换当前 tab 的内容区。
   */
  // 打开面板前焦点在哪。关面板时还回去 —— 原生浮层都这么做，
  // 否则焦点被留在已经 display:none 的树里，键盘接下来没有落点。
  var lastFocus = null;

  function openPanel() {
    if (state.destroyed) return;
    if (!state.cfg && !state.loading) loadAll();
    try { lastFocus = document.activeElement; } catch (eLF) { lastFocus = null; }
    state.open = true;
    ensureHost();
    ensureMounted();
    applyScheme();
    applyGlass();
    if (S.wrap) S.wrap.setAttribute("data-open", "1");
    state.paintedKey = "";
    paint();
    try { if (S.card) S.card.focus({ preventScroll: true }); } catch (e2) { /* 老引擎不认 options */ }
    syncLauncher();
  }

  function closePanel() {
    state.open = false;
    state.query = "";
    if (S.search) S.search.value = "";
    if (S.wrap) S.wrap.setAttribute("data-open", "0");
    syncStatus();
    syncLauncher();
    var back = lastFocus;
    lastFocus = null;
    if (back && back.focus) {
      try { back.focus({ preventScroll: true }); } catch (eFB) { try { back.focus(); } catch (eFC) {} }
    }
  }

  // 对外仍然是 show/hide/toggle 三个名字（CWE.panel / CWE.openPanel 在用）
  function show() { openPanel(); }
  function hide() { closePanel(); }
  function toggle() { if (state.open) closePanel(); else openPanel(); }

  // ---------------- 键盘与外部入口 ----------------

  function onKey(e) {
    if (!e || !e.key) return;
    var k = String(e.key).toLowerCase();

    // ⌥⌘W（macOS）/ Alt+Ctrl+W —— 开合面板，不占用 Codex 自己的快捷键
    if (k === "w" && e.altKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
      return;
    }

    // ⌥⌘, —— 跟系统「偏好设置」同一个手势，肌肉记忆能接上
    if (k === "," && e.altKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (state.open) closePanel(); else openPanel();
      return;
    }

    // Esc：只在焦点确实在面板里时才收面板。焦点在 Codex 正文里时 Esc 是它自己的
    // （停止生成），那个键不能抢。
    if (k === "escape" && state.open) {
      var hostFocused = document.activeElement === host;
      if (!hostFocused) return;
      var a = activeEl();
      var tag = a && a.tagName ? a.tagName : "";
      if (a === S.search) {
        if (state.query) { state.query = ""; a.value = ""; paint(); }
        else closePanel();
        e.stopPropagation();
        return;
      }
      // 输入控件里的 Esc 归控件自己（改名框的 Esc = 放弃改名，由 onKeyDown 处理）
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (state.query) {
        state.query = "";
        if (S.search) S.search.value = "";
        paint();
      } else {
        closePanel();
      }
      e.stopPropagation();
    }
  }

  try {
    window.addEventListener("keydown", onKey, true);
  } catch (e) { /* 忽略 */ }

  /** 宿主每次 apply 都会推回 payload —— 借这个通道刷新一次清单（清单可能变）。 */
  /**
   * 宿主每次 apply 都会调它。面板开着就静默重拉一次（壁纸清单 / 配置可能已变）。
   * 面板关着就什么都不做 —— 别让后台轮询打到自己。
   */
  var refreshTimer = null;
  function onHostApply(next) {
    if (!state.open) return;
    if (next && next.base) state.base = next.base;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refreshTimer = null; loadAll({ quiet: true }); }, 500);
  }

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    state.open = false;
    state.loadSeq++;
    state.saveSeq++;
    [state.saveTimer, dragTimer, msgTimer, relayouting, refreshTimer, undoTimer, warmupTimer].forEach(function (t) { if (t) clearTimeout(t); });
    if (bootTimer) { try { clearInterval(bootTimer); } catch (eB) {} bootTimer = 0; }
    if (entrySweep) { try { clearInterval(entrySweep); } catch (eS) {} entrySweep = 0; }
    try { window.removeEventListener("resize", scheduleRelayout, false); } catch (e) {}
    try { window.removeEventListener("keydown", onKey, true); } catch (e) {}
    if (themeObserver) { try { themeObserver.disconnect(); } catch (e) {} themeObserver = null; }
    // 只删 navEntry 不够：页面里可能还留着上一次实例（或半途重挂）产生的入口。
    // 生命周期结束必须让 DOM 回到接进来之前的样子，否则会看到「插件卸了但图标还在」。
    if (navEntry) { try { navEntry.remove(); } catch (e) {} navEntry = null; }
    try {
      var strays = document.querySelectorAll('[data-cwe-entry="wallpaper"]');
      for (var si = 0; si < strays.length; si++) strays[si].remove();
    } catch (eStray) { /* 文档已卸载时忽略 */ }
    state.mountedEntry = false;
    if (navResizeObserver) { try { navResizeObserver.disconnect(); } catch (e) {} navResizeObserver = null; }
    if (CWE) { delete CWE.panel; delete CWE.openPanel; }
    try { host && host.remove(); } catch (e) {}
    S = {};
    return { ok: true };
  }
  CWE.panel = { __inst: INSTANCE, version: VERSION, fp: FP, show: show, hide: hide, toggle: toggle, reload: loadAll, onHostApply: onHostApply, destroy: destroy };
  CWE.openPanel = show;

  // 首次静默预热：拿一次 cfg，用于决定启动按钮是否显示
  var warmupTimer = setTimeout(function () { warmupTimer = 0; if (!state.destroyed && !state.cfg) loadAll({ quiet: true }); }, 400);
  watchHost();
  // 入口不等用户开面板：注入就挂（nav 还没渲染出来就短轮询等）。
  bootEntryWatch();
  startEntrySweep();
})();

# STATUS · codex-wallpaper-engine（2026-11-17 17:05 落盘）

## 当前版本
- src/inject/panel.js  VERSION 0.17.8 / FP native-21-no-note（开关点击已接线；开玻璃自动补值；已移除行内说明文字）
- src/inject/runtime.js  VERSION 0.8.4（unmount 先调 panel.destroy；会话列表玻璃四旋钮）
- src/host/injector.mjs  自愈重试（scheduleRetry + watchTick）
- package.json 与 .codex-plugin/plugin.json 均 0.10.4
- src/host/settings-schema.mjs DEFAULTS 与 src/host/presets.mjs 内置预设已按「窄栏 blur 上限」重标定
- 运行态：宿主 http://127.0.0.1:51745（**端口会随每次 stop/start 变，别写死**），CDP 9333，pid 69643
- runtime.json：{"port": 51745, "url": "http://127.0.0.1:51745", "cdpPort": 9333, "cdpPortPreferred": 9333, "cdpPortState": "cdp", "pid": 69643, "startedAt": 1794983269599, "version": "0.10.4", "prefix": "/wallpaper-engine", "panel": "http://127.0.0.1:51745/wallpaper-engine/panel"}

### 侧栏现在这组值（真机定稿，别随手改回大 blur）
`sidebarAlpha 0 / sidebarBlur 0 / conversationSidebarAlpha 14 / conversationSidebarBlur 4 / conversationSidebarTint #0c1219 / conversationSidebarSaturate 114 / conversationSidebarBrightness 108 / conversationSidebarEdge true / cweUiAlpha 0.03 / cweUiAlphaMain 0.18 / settingsWindowTransparency 0 / settingsWindowBlur 3`（2026-11-18 14:34 实测 config.json；此前定稿的 22/14/26/16/180/0.30/0.24 已由用户在面板里改成这一版更薄的）
实测：`nav` = `rgba(255,255,255,0.22)` + `blur(14px) saturate(1.4)`；会话列表 = `color(srgb .094 .094 .094 / 0.44)` + `blur(16px) saturate(1.25)`；主内容面暗底 over ≈ 0.079（`(0.30-0.24)/(1-0.24)`），壁纸透亮、字读得清。

## 2026-11-18 18:36 · 「这些开关全部都没有用」—— onClick 里根本没有 toggle 分支（0.10.4 / panel 0.17.7）

用户附了一张设置面板的截图（六个玻璃开关），说「你的这些开关全部都没有用，你解决一下这些开关的问题」。

### 根因（不是样式，是事件没接线）
`src/inject/panel.js` 的 `onClick`（改前 :1810-1882）逐条分支只有 data-tab / data-act / data-goto / data-tile-del / data-id / data-grp / data-grp-del / data-gm / data-img / data-imgdel / data-glass / data-font / data-family / data-preset-*。**没有任何一条处理 `button.sw`**，也没有 `data-key` + toggle 的通用分支。而 `fieldHtml`（:718）把 26 个开关渲染成 `<button class="sw" data-key="KEY" data-on="0|1">` —— 点下去一路落空，直接 return。
`.backups/local-fix-20261118/panel.js.bak-1425` 与 `panel.js.bak-101825` 里 onClick 同样没有这条分支：**这是长期存在的老 bug，不是本轮改出来的**。

### 改动
1. `onClick` 开头插入 toggle 分支：`closestAttr(t,"data-key")` 取到元素后，**只认 `tagName==="BUTTON" && classList.contains("sw")`**（滑块、取色器、文本框身上也有 data-key，不能一并当开关），取反后先乐观上屏（`data-on` / `aria-checked`）再 `patch()`，等宿主回包由 `syncField` 校正。
2. 开玻璃时自动补值：`titlebarGlass` 打开而 transparency 与 blur 都是 0 时，补 86 / 18；`rightSidebarGlass` 同理补 84 / 20。否则「打开玻璃」这个动作本身没有可见效果（color-mix 出来 0%，blur(0px)）。
3. ~~新增 `ineffectiveNote(key)` 行内小字~~ —— **当天被用户否掉并删除**（「这些黄字没必要，删了」）。连带删掉 `syncWhyNotes()`、`.row .k small.why` 的 CSS 规则、`flushPending` 里的调用。教训：把诊断结论写进用户界面之前先问一句，用户要的是开关能用，不是解释为什么看不出来。
4. schema 里给 titlebar* / rightSidebar* / overlayGlass 补 title 提示，说清各自在什么条件下才可见。

### 验收（CDP 实测）
- `/tmp/toggle-test.mjs`：点 conversationSidebarEdge → `data-on` 1→0，config.json `true→false`，`#cwe-style` 13124→13008 字符，边缘 box-shadow 消失。再点一次恢复 true。
- `/tmp/toggle-fail.mjs`：8 个此前失败的开关（flip / rotationEnabled / sidebarGlass / ropeShown / fontCustom / cweEnabled / cweInjectOnStart / cweAutoRelaunch）逐个点击，config 全部跟随翻转。
- ~~`/tmp/note-verify.mjs` 验证 why 小字~~ —— 该功能已按用户要求移除。0.17.8 实测 `whyCount: 0 / anyNote: 0`，玻璃页 27 行、无任何附注文字。
- `/tmp/seed2.mjs`：把 titlebar 两个值清零并关掉玻璃，点开关 → config 变成 `glass:true, tr:86, bl:18`。
- 滑块链路本来就通，无需改：titlebarBlur 0→40 / titlebarTransparency 0→78 / sidebarBlur 14→30 都会进 config 并改 CSS。

### 一个被排除的方向（记录，免得下次重复排查）
「开关没反应」一度怀疑是 CSS 生成层有死键。实测不是：20 个玻璃键逐个翻转，`#cwe-style` 文本 20/20 全部变化；像素级 diff 也确实有变化（conversationSidebarGlass 14.456%、sidebarGlass 3.224%、titlebarTransparency 5.092%）。唯一 0 变化的是 `rightSidebarBlur` —— 因为右面板收起时命中元素 rect 宽 0，这类属于「目标不可见」，已在 UI 上用 why 小字说明，不再当成 bug 修。

## 2026-11-18 14:40 · 清掉 schema 里最后 35 个孤儿键（0.10.4 / panel 0.17.4）

用户上一轮之后追加：「清理干净」。指的是面板上看不见、也没人消费的那批默认值。

### 判据（可复跑）
脚本 /tmp/audit-defaults.mjs：把 `DEFAULTS` 的顶层键全取出来，在除 schema 自身之外的整个仓库（.mjs/.js/.json/.md，排除 node_modules / dist / .backups）里数 `\bKEY\b` 的命中。0 命中 = 孤儿。

- 清理前：DEFAULTS 148 键，孤儿 33。
- 清理后：DEFAULTS **113 键，孤儿 0**。
- GROUPS 面板字段未变：10 组 / 87 项（这批键本来就不在面板上）。
- config.json：148 键 → **113 键**。

### 删掉的 35 个键
`pauseOnHidden / pauseOnBlur / pauseOnBattery / pickerLayout / glassColor / glassDarkSeparate / glassFidelity / capsuleBlur / capsuleColor / chatGlassFidelity / glassMode / glassSurfacePolicy / floaterSolidBase / thinkingTriggerTransparency / thinkingTriggerBlur / leftSidebarTransparency / leftSidebarBlur / rightSidebarCornerRadius / thinkingGlass / thinkingNative / sidebarFollowGlobal / avatarAiRepeatRows / avatarUserImage / avatarAiImage / mascotImageBox / parallaxPlugin / parallaxPluginDepths / uiColorCustom / uiColorSend / uiColorLink / uiColorFileIcon / uiColorTab / uiColorDeepDiving / caretColor / themeFollow`

连带清掉：
- sanitize 里对应的 54 行赋值（含 `glassColor` 的三行块、`glassMode`/`glassSurfacePolicy` 的 objOf 块、`uiColor*` 的 for 循环块）。
- 已无调用点的 `objOf()` 工具函数（它只服务 glassMode / glassSurfacePolicy 这两个对象键）。
- presets.mjs:43 注释里对 glassMode / glassColor 的引用（改成 rotationGroups 举例）。

保留（有真实消费者，脚本判据之外人工确认）：
- `videoVolume` / `videoAudioEnabled` → controller.mjs:241-242（`volume: cfg.videoAudioEnabled ? cfg.videoVolume : 0`）。
- `contentRatingFilter` → controller.mjs:24-25 / 64-65（选片过滤）。
- `switchTransitionDir` / `switchTransitionSpeed` → controller.mjs:244-245。
- `leftSidebarCornerRadius` / `sidebarContentAlpha` / `sidebarContentColor` / `conversationColor` / `fontCustom` / `mascotImage` → 都在 controller 的 payload 里。
- `rotationSeeded` → presets.mjs。

### 落盘顺序上的坑（重要）
只改 schema 不会让 config.json 瘦下来。`loadConfig()` 读到盘上的 JSON 后走 `sanitize()` 缓存，**不写回盘**；必须触发一次写（`updateConfig` / `saveConfig` / `resetConfig`）才会用新 schema 重写整份文件。
本次用 `POST $BASE/wallpaper-engine/settings -d '{"noticeSeen":""}'`（一个无副作用的键）触发，返回 200 后 config 从 148 键变 113 键。
★ 这条对以后任何「删键」都成立：**改 schema + 一次写盘**，否则用户盘上永远留着旧键。

### 验收
- `node --check`：settings-schema / presets / controller / panel 全过。
- `node tools/test-presets.mjs` → RESULT **24/24**（含「内置预设无越界键」「presetKeys 含设置面板玻璃两键」「HTTP keys 同步」）。
- `node tools/test-payload.mjs` / `node tools/test-server.mjs` → 正常出 payload 与 SETTINGS groups **10** version 8。
- 面板 12 个 tab / 87 行字段，标签裁切 0、折行 0（/tmp/audit-wrap.mjs）。
- 宿主重启后注入仍是「已挂上 · image · 不透明度 100%」。
- settings-schema.mjs 与 presets.mjs 已同步到插件缓存并 node --check 通过。

## 2026-11-18 14:20 · 「设置面板有些开关就是摆设 / 面板太胖」—— 删 12 个死键 + 面板压窄到 768px（0.10.4 / panel 0.17.4）

### 用户诉求
「插件的兼容性还是不到位，设置面板里面有些开关就是摆设，如果没有用的开关直接删除，设置面板总体显得太胖，你压缩窄一点」+ 截图（486x98，「会话列表边缘厚度」标签被裁）；
补充：「设置面板的那些字的排版可以稍微拓宽一下间距，其他地方同理，稍微拓宽一点不至于很挤」

### 一、死键审计（脚本化，可复跑）
判据链：GROUPS 里的 key → controller.mjs 是否 `cfg.<key>` 读取 → 生成的 payload 叶子名 → 该叶子名在 src/inject/runtime.js / panel.js 是否存在。三步任一断掉就是摆设。
可复跑脚本 /tmp/audit-groups.mjs（`node /tmp/audit-groups.mjs <repo>`）：取 GROUPS 的 92 个 key，按 `name: <expr>` 抽叶子名，回查两个 inject 文件。

**删掉的 12 个键**（DEFAULTS + sanitize + GROUPS 共 29 行；controller payload 同步删）：

| 键 | 断点 |
|---|---|
| glassAlpha | 全仓除 schema 外 0 命中 |
| parallaxMascot | controller 的 parallax payload 无 mascot 字段 |
| cweKeepHostAlive | bin/cwe-watch.mjs 只读 cweAutoRelaunch |
| cweLaunchAtLogin | 早就不在 GROUPS，DEFAULTS/sanitize 残留 |
| parallaxSidebarDepth / parallaxComposerDepth | payload 叶子 sidebarDepth / composerDepth 在 runtime/panel 零命中 |
| parallaxUiChatDepth / parallaxBubbleDepth | 同上（chatDepth / bubbleDepth） |
| sidebarFullClear | payload 叶子 fullClear 在 runtime 零命中 |
| leftSidebarSquare / rightSidebarSquare | payload 叶子 square 在 runtime 零命中 |
| fpsCap | payload 叶子 fpsCap 在 runtime 零命中（且 GROUPS 本就没有字段） |

**保留的「疑似死键」**（复核后确认有消费者，别再删）：
- settingsWindowTransparency / settingsWindowBlur —— panel.js 自读自写（applyGlass 设 --ga/--gb，:1351-1360；预设行 :1901 patchMany 回写），是面板自己的旋钮，不进 payload 所以脚本会误判。
- cweInjectOnStart（src/host/daemon.mjs:167）、cwePort（bin/cwe.mjs:114/443、bin/cwe-watch.mjs:318）、cweAutoRelaunch（bin/cwe-watch.mjs:321）。

### 二、面板压窄 + 间距放宽（两轮）
CSS 全部在 src/inject/panel.js:687 那一个双引号字面量里，改动一律用脚本做子串替换再 node --check。
- 第一轮（/tmp/apply-compact.mjs，14 处）：.card 900→742px、.nav 168→150、.row .k 136→118、.body padding 收紧、range max-width:300px。
- 第二轮（/tmp/apply-spacing.mjs，27 处，用户要求「间距拓宽」）：.card **768×700px**、line-height **1.6**；.nav **158px**；.brand 46px；.item **32px**；.hdr **48px**；.body padding **14/17/15 gap 14**；.row **gap14 pad 6 2 7 min-h34**；.row .k **128px / 13px / lh19**；range max-width **340px**；.grid minmax 140 gap 10；@media900 .k 112。

**结论：宽度比原来窄 132px（900→768），但行高从 1.45 提到 1.6、行内 gap 与块间距都放大 —— 视觉上更松不更挤。**

### 三、验收（CDP 实测）
- `window.__CWE.panel` → ver `0.17.4` / fp `native-17-spacing`；card rect {x:351,y:67,w:768,h:700}；nav 158；body padding 14/17/15、gap 14；.row .k 128px/13px/lh19；.item 32px。
- 全 12 个 tab 扫描 .row[data-field] 共 87 行，标签溢出检测 `scrollWidth > clientWidth` 与 Range 文本宽度 > 盒宽 —— **0 条被裁**（改前那条「会话列表边缘厚度」已放得下）。
- glass 页字段 27 个，glassAlpha / 三个 parallax 深度 / 保活 均已从 UI 消失。

### 三·补、标签重命名（压窄后二次复查发现）
128px 标签列下有三条标签会折行（实测 `scrollHeight > 1.6×lineHeight`）：`sidebarEdgeBlend`「侧栏右缘接缝融入玻璃」(117px/128px)、`overlayGlass`「菜单、搜索与弹窗玻璃」(117)、`cweAutoRelaunch`「Dock 启动时补调试端口」(126)。→ 分别改为「侧栏接缝融入玻璃」「菜单与弹窗玻璃」「Dock 启动补端口」，改完 **全 12 个 tab 折行数 = 0**。
选重命名而非加宽标签列：加宽会把刚压窄的面板又推胖，改字更省。

### 四、踩坑
- `cwe set` 打在旧宿主上，新键返回 undefined（宿主钳制）—— 改了 schema/controller 必须 `cwe stop` + `cwe start --detach` 才生效；只改 panel.js / runtime.js 则不必（injector 按 mtime+size 缓存）。
- 改 panel.js 必须升 VERSION 与 FP，否则页面里同版本旧实例在 :29 直接 return，新代码永远进不来。
- 探针里手写转义会炸 `SyntaxError: Invalid or unexpected token`：页面表达式先拼成普通字符串，再用 JSON.stringify 注入。

### 五、同步
settings-schema.mjs / controller.mjs / panel.js 三个文件已 cp 到 ~/.codex/plugins/cache/cwe/codex-wallpaper-engine/0.10.4/ 对应路径，diff 一致 + node --check 全过（标签重命名后的 schema 又同步了一次）。

当前活体（14:36）：宿主 pid 72565 / http://127.0.0.1:52824，CDP 9333，注入「已挂上 · image · 不透明度 100%」。

## 2026-11-18 12:38 · 「本机codex又打不开了」—— 看门人换端口造出「有进程、无窗口」（0.10.4）

### 用户诉求
「本机codex又打不开了，你修复一下」

### 现象（改前实测）
`ps` 里 Codex 活得好好的：`pid 44022 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9333`，etime 只有 26 秒。
`curl http://127.0.0.1:9333/json/version` 也正常返回 Chrome/157.0.8103.78。
但 `curl .../json/list` 返回 `[  ]`（空数组），System Events 数窗口 = 0，桌面上 ChatGPT 是当前应用却没有窗口。
用户看到的就是「点 Dock 没反应」。

### 根因
`bin/cwe-watch.mjs` 的换端口分支只做了两件事：`quitAndWait(pid)`（直接 SIGTERM）+ `/usr/bin/open -na <bundle> --args --remote-debugging-port=9333`。
watch.log 里能直接看到这两步：
`[2026-11-18 12:36:45] info 发现刚启动的 Codex pid=43981（00:00）没有调试端口，换成带端口的同一份二进制`
`[2026-11-18 12:36:46] info 已用 --remote-debugging-port=9333 重新拉起 Codex`
进程确实起来了，但窗口没跟着回来 —— `open -na` 这条路在这台机器上不保证开窗。于是留下一个「进程在、CDP 在、一个页面都没有」的实例。

### 改法（bin/cwe-watch.mjs）
把「起来了」和「能用了」分开判：

1. **退出走 App 自己的流程**：`quitAndWait` → `gracefulQuit(app.bundle, pid, GRACEFUL_QUIT_MS=8000)`（osascript `tell application "X" to quit`，超时才回退信号）。直接 SIGTERM 会让窗口状态跟着丢。
2. **换端口后要验主窗口**，不是验「有没有页面」：
   - `isMainWindowUrl(url)` 与 `src/host/cdp.mjs` 的 `isMainUrl` 同一判据 —— `app://-/index.html` 且 `initialRoute` 不是 `avatar-overlay` / `detached-window`。只比前缀会把头像浮层当成主窗口。
   - `mainWindowPages(port)` 数主窗口 page；`pageCount(port)` 数全部 page。两者失败都返回 **-1**（不知道），绝不返回 0。
   - `waitForMainWindow(port, LAUNCH_WINDOW_WAIT_MS=9000)`：open 之后等主窗口。
3. **open 不出窗就换直启**：等不到主窗口 → 杀掉残留主进程 → sleep 1200 → `launchBinary(app, port)`（`spawn(app.bin, ["--remote-debugging-port="+port], {detached}`，即 `cwe launch` 那条路径，实测能出窗）→ `waitForMainWindow(chosenPort, REOPEN_WAIT_MS=6000)`；仍失败 `notify("壁纸引擎：Codex 没起来", "自动重开没成功，请手动点一次 Codex。")`。
4. **新增「窗口健康」常驻看守**（每 `WINDOW_PROBE_MS=5000` 一次）：
   `const mains = await mainWindowPages(chosenPort); const wins = mains >= 0 ? -1 : windowCount(app.bundle); const lost = mains === 0 || wins === 0;`
   连续 `NO_WINDOW_STRIKES=3` 次丢失、且距上次恢复超过 `NO_WINDOW_RECOVER_COOLDOWN_MS=60000`，才 gracefulQuit + launchBinary 重开一次。
   任何探针返回 -1（问不到）时什么都不做 —— 宁可不救，也不误杀用户正在写东西的窗口。
5. `windowCount(bundle)` 必须走 System Events：`tell application "System Events" to tell process "ChatGPT" to get count of windows`。
   直接问 App 会报 -1708（`"every window"不理解"count"信息`）—— 这个 App 的 AppleScript 字典里没有 window 类。

### 验收
- 修完实测 `/json/list`：total 9、page 3、**mainWindowPages 1**（修正前只比前缀会数成 2，把 avatar-overlay 算进去）。
- `isMainWindowUrl` 五例单测全对：`app://-/index.html`→true；两个 initialRoute 变体与 `detached-window.html`→false；`""`→false。
- `node --check bin/cwe-watch.mjs` → WATCH_OK。
- `launchctl kickstart -k gui/$(id -u)/com.codexwallpaper.engine.watch` 重启看门人 → pid 61793，watch.log `[2026-11-18 12:43:27] info 看门人启动 pid=61793，轮询 500ms`。
- `bin/cwe-watch.mjs` 已 cp 到 `~/.codex/plugins/cache/cwe/codex-wallpaper-engine/0.10.4/bin/`，双向 diff 一致、缓存内 `node --check` 通过。

### 现场恢复记录
故障当口用 `osascript -e 'tell application "ChatGPT" to quit'`（100ms 退出）+ `node bin/cwe.mjs launch`（pid 54506，带 9333）恢复；
窗口数回到 1，`POST /wallpaper-engine/apply` 返回 200，注入恢复「已挂上 · image · 不透明度 100%」。

### 教训
- 「进程在」不等于「能用」。Electron 应用完全可能出现「主进程活着、CDP 活着、一个窗口都没有」的状态，判据必须落到**主窗口 page**上。
- 探针失败要返回 -1，不要返回 0。「问不到」和「确实没有」混为一谈，自动恢复逻辑就会误杀。
- `open -na` 不保证开窗；同一条二进制直启（带参数 spawn）才是可靠的。

## 2026-11-18 10:26 · 「出bug了，有两个图标」—— 浮球与原生入口互斥 + 观察器活锁（0.10.4 / panel 0.17.2）

### 用户诉求
「出bug了，有两个图标」（附截图：图标栏下半段出现两个相同的图片图标，纵向相邻）

### 现象与根因（两个独立缺陷，先后叠加）
1. **浮球和原生入口同时显示。** 图标栏 y=658 是 `#cwe-panel-host` shadowRoot 里的 `.launcher` 浮球（position:fixed，36×36），
   y=702 是克隆出来的原生入口 `button[data-cwe-entry="wallpaper"]` —— 两者相差 44px，看起来就是"两个图标"。
   `mountNativeEntry()` 里确实有三处把 launcher 设 `display:none`，但 `ensureMounted()` 紧接着执行
   `root.innerHTML = "<style>" + CSS + "</style>" + shellHtml()` 重建整棵 DOM，新的 launcher 节点重新出现；
   随后 `syncStatus()` 又按 `launcherShown()` 把 `data-show` 设回 `"1"`。而 `launcherShown()` 只看
   `cfg.cweLauncher !== false`（settings-schema 里根本没有这个键），**完全不看原生入口是否已挂上**。
2. **删一个、补一个的拉锯。** 用 `Node.prototype.insertBefore/appendChild` 打桩抓到调用栈：
   `placeEntry (:1584) ← mountNativeEntry (:1650) ← MutationObserver (:1658)`。
   `reconcileEntries()` 只删多余节点、**不认领保留下来的那个**，`navEntry` 仍指向被删掉的节点；
   nav 的 MutationObserver 见 `!nav.contains(navEntry)` 成立 → 重新克隆一个 → 永远收敛不到 1 个。

### 改法
- 新增 `entryMounted()`：navEntry 在文档里，或 `document.querySelector('[data-cwe-entry="wallpaper"]')` 命中，就算已挂。
- 新增 `launcherVisible()`：`!state.open && launcherShown() && !entryMounted() && !!S.launcher`。
- 新增 `syncLauncher()`：同时设 `data-show` 与 inline display，只在要显示时 `positionLauncher()`。
  替换全部旧调用点：`ensureMounted` 尾部、`syncStatus`、`mountNativeEntry` 三处 display 赋值与兜底、
  `openPanel` / `closePanel`。★ 重建 DOM 后必须重算 —— 这是本 bug 的正面修法。
- `reconcileEntries()` 末尾加 `navEntry = keep;` 认领；`bootEntry()` 开头先跑一次 reconcile
  （原来 navEntry 存在就直接 return，去重代码根本没机会跑）。
- 新增 `startEntrySweep()`：1.5 秒一次，只在 `navEntry` 有效且 `querySelectorAll` 长度 > 1 时才 reconcile，
  `destroy()` 里 clearInterval。
- VERSION 0.17.0 → **0.17.2**，FP native-13-boot-entry → **native-15-single-entry**（不升 FP 旧实例会直接 return）。

### 踩坑：观察器里改 DOM = 活锁
中途在 MutationObserver 回调里加了 `reconcileEntries()`，形成
`remove → mutation → reconcile → mount → append → mutation` 的死循环，渲染进程 100% CPU，
`Runtime.evaluate` 全部 `cdp timeout`，连 `Page.reload` 都救不回来（活锁在页面 JS 里，reload 打断不了宿主的 CDP 会话）。
唯一解是 `osascript -e 'tell application "ChatGPT" to quit'` 后 `cwe launch` 重开整窗。
**教训：MutationObserver 回调里只能读状态，不能改 DOM。**（已写进注释）

### 验收（CDP 9333，重开 Codex 后）
`{"ver":"0.17.2","fp":"native-15-single-entry","launcher":{"dataShow":"0","display":"none","rect":[0,0,0,0]},"entries":[{"x":8,"y":702,"w":36,"h":36}],"entryCount":1}`
截图确认图标栏只剩一个壁纸图标，整窗壁纸与玻璃正常。

### 同步
`src/inject/panel.js` 已 cp 到 `~/.codex/plugins/cache/cwe/codex-wallpaper-engine/0.10.4/src/inject/`，
双向 diff 一致、`node --check` 通过。

## 2026-11-18 10:10 · 「左侧那个会话侧边栏的玻璃样式我不喜欢」（0.10.4 / runtime 0.8.4）

### 用户诉求
「你把玻璃设置再优化一下，左侧那个会话侧边栏的玻璃样式我不喜欢」

### 现象（改前实测）
会话列表 div.sidebar-navigation = `color(srgb .094 .094 .094 / 0.44)` + `blur(16px) saturate(1.25)`，
颜色恒取 `--cwe-surface`（#181818）的 alpha 混合 —— 所以它永远是**一块深灰实心板**：
238px 窄栏里 16px 模糊把壁纸平均掉，读不出任何材质；而左边 52px 图标栏是 `rgba(255,255,255,0.22)`，
一白一黑并排，接缝生硬。根因不是配置值，是代码里这条分支只有 alpha 和 blur 两个自由度。

### 改法：把会话列表从「深灰板」做成「深冷墨薄片」
按液态玻璃四成因补齐（模糊 / 边缘高光 / 环境色渗透 / 厚度阴影），并新增 4 个旋钮：

- **墨色 tint** `conversationSidebarTint`（默认 `#0a0e14`）：换成偏冷的深墨蓝，不再是中性的 #181818，
  壁纸的暖光透进来时会染出一层冷调，与左侧白色图标栏形成「冷边 / 暖底」而不是「黑 / 白」。
- **色彩浓度** `conversationSidebarSaturate`（100–200，默认 165）：>100 才让壁纸的颜色渗进玻璃。
- **提亮** `conversationSidebarBrightness`（90–130，默认 108）：深色玻璃是「减光」，略微抬 brightness
  才能把背后的光提出来，不至于发闷。
- **边缘厚度** `conversationSidebarEdge`（默认 true）：右缘 1px 白线 `rgba(255,255,255,.15)` 当玻璃断面，
  外加 `inset 0 0 0 1px rgba(255,255,255,.06)` 极淡整圈描边和 `inset 0 -16px 22px -14px rgba(0,0,0,.34)` 底部内阴影。

外加一条**纵向光泽渐变**（顶亮 → 中段归零 → 底部压暗），给这块薄片一点厚度：

```
linear-gradient(to bottom,
  rgba(255,255,255,.12) 0%, rgba(255,255,255,.035) 26%,
  rgba(255,255,255,.006) 50%, rgba(0,0,0,.11) 100%)
```

★ 两个必须记住的约束：
1. `glass()` 会强制 `background-image:none !important`，所以渐变规则**必须写在 glass() 之后**、同选择器，
   否则被它盖掉（探针里 `listImg` 为空就是这条没写对）。
2. `backdrop-filter` 里 **blur 必须排第一位**，`brightness()` 追加在 saturate 之后；
   saturate 放前面会出色边。

### 最终落定的值
`conversationSidebarAlpha 26 / Blur 16 / Tint #0c1219 / Saturate 180 / Brightness 108 / Edge true`
（中间试过 32/165/112 与 42/150/100 两版：前者仍偏灰、后者偏亮把字压薄，26/180/108 这版壁纸的
暖光能明显透进左下角、文字对比仍然够。）

配套数值改动：
- `settings-schema.mjs` DEFAULTS：conversationSidebarAlpha 44→32、新增 tint/saturate/brightness/edge 四项；
  sanitize 加四条；面板 group `glass` 里加四个控件（墨色 color / 色彩浓度 range 100-200 / 提亮 range 90-130 / 边缘厚度 toggle）。
- `controller.mjs:257` payload 从 `{on, alpha, blur}` 扩成 `{on, alpha, blur, tint, saturate, brightness, edge}`。
- `presets.mjs`：glass-dark 同步为 32/#0a0e14/165/112/true，clear-max 为 26/170/116/true。

### 踩到的坑
- `cwe set` 打在**改代码之前**启动的宿主上，四个新键返回 `undefined（宿主钳制）` —— schema 是启动时加载的，
  必须先 `cwe stop` + `cwe start --detach` 再 set。
- runtime.js 由 injector 的 `readInject()` 按 mtime+size 缓存，改它不必重启宿主；
  但 **schema / controller 改了必须重启宿主**。
- 改 runtime.js 一定要升 `VERSION`，否则页面里旧运行时的幂等分支会让新代码永不生效（这次 0.8.2 → 0.8.3 → 0.8.4）。

### 验收
CDP 实测（runtime 0.8.4）：
`listBg = color(srgb .047 .071 .098 / 0.26)` / `listBf = blur(16px) saturate(1.8) brightness(1.08)` /
`listShadow` 含右缘 `.15` 白线与底部内阴影 / `listImg` = 上面那条渐变。
截图对比 `/tmp/side-before.png`（改前均匀深灰）与 `/tmp/side-D.png`（改后：左上角暖光透出、
右缘一道细亮线、底部收暗）。

### 同步
四个文件已 cp 到 `~/.codex/plugins/cache/cwe/codex-wallpaper-engine/0.10.4/` 并 `node --check` 通过。

## 2026-11-17 17:05 · 「这个侧栏你给他恢复一下」—— 灰板是 blur 造成的（0.10.4）

### 用户诉求
「这个侧栏你给他恢复一下」

### 现象
侧栏能看见，但 238px 的会话列表是一整块灰雾，把壁纸压死；52px 图标 rail 也几乎没有玻璃感。
第一反应是「配置没生效」——页面 `state.glass.sidebar` 是 `alpha 10 / blur 1`，而 `config.json` 写的是 `42 / 24`。
实际读盘后发现**两边一致**：磁盘上就是 `sidebarAlpha 10 / sidebarBlur 1`、`conversationSidebarAlpha 70 / conversationSidebarBlur 18`、`cweUiAlphaMain 0.3`。不是 bug，是值本身极端。

### 根因 A：窄栏上的 blur 会把背景平均成灰板
三层背景全归零（`conversationSidebarAlpha=0 sidebarAlpha=0 cweUiAlphaMain=0`）之后画面**几乎没变，还是灰的**。
用 `document.elementsFromPoint(64,400)` 逐层 dump 37 层，发现真正在绘制的只有两处：
`div.sidebar-navigation`（`bg color(srgb 0 0 0 / 0)`、`bf blur(8px) saturate(1.25)`、238×787）和 `PageSurfaceLayout-`。
→ **238px 的窄条上做 blur，等于把壁纸细节平均成一片均匀灰雾；blur 越大越像灰板，透明度再低也救不回来。**
把 blur 归零后壁纸细节立刻透出来（但文字直接压在画面上，可读性崩）——这条对照实验定死了因果关系。

### 根因 B：主区整体变暗，是 over 公式被破坏
`src/inject/runtime.js:231-244`：
```js
const a = Math.max(state.uiAlphaMain, state.uiAlpha);
const am = state.uiAlphaMain;
const over = am >= 1 ? 0 : (a - am) / (1 - am);
...
shell + " :is(" + s.main + "," + s.webview + "){background-color:" + tint(base, over) + " !important;}"
```
主内容面的暗底 = `over = (uiAlpha − uiAlphaMain) / (1 − uiAlphaMain)`。
我把 `uiAlphaMain` 从 0.58 降到 0.24 却忘了同步 `uiAlpha`（仍是 0.62）→ over 从 0.095 涨到 **0.50**，
实测 `main[class*='MainContentSurface-']` 的 backgroundColor 正是 `color(srgb .094 .094 .094 / 0.5)`。
修法：`uiAlpha` 必须贴着 `uiAlphaMain`（现取 0.30 vs 0.24，over ≈ 0.079）。

### 代码侧固化（不是只改 config）
- `src/host/settings-schema.mjs` DEFAULTS：`sidebarBlur 16→14`、`sidebarAlpha 52→22`、`conversationSidebarAlpha 70→44`、`conversationSidebarBlur 18→16`、`cweUiAlphaMain 0.58→0.24`、`cweUiAlpha 0.66→0.30`，并在默认值旁写了「窄条上模糊超过 ~16px 会把壁纸平均成灰板」的中文注释。
- `src/host/presets.mjs`：`glass-dark` 改为 `22/14 + 44/16 + uiAlpha 0.30 / uiAlphaMain 0.24 / scrim 0.12`（前面加注释解释 over 公式）；`clear-max` 改为 `22/14 + 40/15`；`plain` 不动。
- `sidebarBlur` / `conversationSidebarBlur` 两个 range 字段加 `tip`，鼠标悬停才出提示：**超过约 16px 会把这条窄栏糊成一块灰板，看不清壁纸**。
- `tools/test-presets.mjs` 里原来写死 `cweUiAlpha === 0.62`，改成读预设自己的声明值（`BUILTIN_PRESETS.find(...).values.cweUiAlpha`）——否则以后每次调预设都要改测试。

### 真机验收
- `node tools/test-presets.mjs` → RESULT 24/24。
- 宿主重启（stop pid 8579 → start --detach）后：`http://127.0.0.1:59940 (pid 9438)`、页面注入已挂上 · image · 不透明度 100%。
- `/tmp/cwe6/verify.mjs`：`nav rgba(255,255,255,0.22) | blur(14px) saturate(1.4)`、`list color(srgb .094 .094 .094 / 0.44) | blur(16px) saturate(1.25)`、`panel 0.17.0`、`entry true`、`rootVis visible`、`media ready`。
- 打包：`node tools/pack.mjs` → `dist/codex-wallpaper-engine-0.10.4-20261117.zip`（56 files / 200.2 KiB）。全回归通过：test-renderer 7 条（含宿主短暂不可达自动恢复）、test-server、test-presets 24/24、test-rotation、test-payload、test-faces、`node bin/smoke.mjs`（opaqueCount 6 / bodyFirstChild cwe-root）。
- 截图对比序列（都在 /tmp/cwe6/）：`v0`（三层归零仍灰）→ `v4-noblur`（blur=0 透但字难读）→ `v5-mid`（10/10+16/12 偏弱）→ `v6`（22/14+44/16 平衡）→ `v8-ui42`（主区偏暗）→ `v9-ui30` / `final-sidebar`（终态）。

### 调参判据（下次别再走弯路）
- `alpha` 只决定「底衬多厚」，**决定发闷的是 blur**；窄栏 blur 上限 ~16px。
- rail 用 `rgba(255,255,255,alpha)`（`sidebarColor=#ffffff`），列表用 `tint(--cwe-surface, alpha)`（暗色 `#181818`）——同样 alpha 下 rail 是白雾、列表是黑雾，数值不能直接对齐。
- 改 `uiAlphaMain` 必须同时改 `uiAlpha`，否则主区会被 over 压暗。

## 2026-11-18 09:20 · 「codex-wallpaper-engine 插件不知道为什么用不了了」—— 看门人消失 + 两处不自愈（0.10.4）

### 用户诉求
「本机的 codex-wallpaper-engine 插件不知道为什么用不了了，你修复一下」

### 现象（修复前实测）
- `~/.codex-wallpaper-engine/runtime.json` 不存在 → 守护没在跑；`cwe status` 输出「守护：没在跑」。
- Codex 主进程 pid 1497 = `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`，命令行里**没有** `--remote-debugging-port`；lsof 无 9333 监听。
- 没有 cwe-watch 进程；`launchctl list | grep -i cwe` 为空；`~/Library/LaunchAgents` 里没有任何 cwe plist。
- cwe.log 末尾：`[15:52:56] warn 连不上主窗口: 未找到主窗口 target "app://-/index.html"；当前 page: []` → `[15:53:03] info shutdown`。

### 根因 1：看门人（launchd 看守）连同 plist 一起没了
历史 watch.log 证明它曾经正常工作（11-17 00:20、07:26、07:57 三次成功给新起的 Codex 补上端口）。
11-17 之后 plist 与进程一起消失，于是 11-18 从 Dock 启动的 Codex 裸奔 → 无 CDP → 宿主连不上主窗口 → 零注入。
**这就是「什么都没干，插件自己坏了」的全部原因。**

修复：`node bin/cwe.mjs autostart on` —— 写回
`~/Library/LaunchAgents/com.codexwallpaper.engine.watch.plist`（label `com.codexwallpaper.engine.watch`），
`launchctl load -w`，并由 launchd 托管常驻。

### 根因 2：cwe-watch.mjs 的宿主看守**不看 CDP**
旧 `tick()` 无条件每 8 秒探一次 `/wallpaper-engine/status`，挂了就 `cwe start --detach`。
Codex 没端口时宿主必然「起→连不上主窗口→退」，于是形成空转连拉 —— watch.log 里
08:06:16 / 08:06:54 / 08:07:27 / 08:08:59 / 08:09:15 / 08:09:32 / 08:10:06 那 7 条「宿主没响应，拉起一个」就是它。

修复（bin/cwe-watch.mjs）：
- 新增 `async function cdpAlive(port)` —— 探 `http://127.0.0.1:PORT/json/version`（1200ms）。
  拉宿主前先过这一关，不通就只记一条 `调试端口 N 上没有端点，宿主起来了也连不上主窗口，先不拉（等 Codex 带上端口）`。
- `lastHostStartAt` 只在**真拉起**时更新 —— 不拉就不占用 15 秒冷却窗口。

### 根因 3：久跑裸实例永不自愈
旧逻辑只换 `etime <= LAUNCH_WINDOW_SEC(2 秒)` 的新进程；跑久了的 Codex 只记一条 warn 就永远放弃。
修复：`notifiedPid` 去重 + `NO_CDP_NOTE_MS=60000`，同一 pid 只弹一次桌面通知
（`/usr/bin/osascript display notification`），日志仍每 60 秒一条。不杀进程 —— 不丢用户正在写的东西。

### 根因 4：CSP reload 之后注入永久停摆（最隐蔽的一处）
表象：`cwe status` 报「页面注入 未挂上」，但宿主活着、CDP 通、runtime.json 正常；CDP 直连 probe 得
`hasCwe=false / root=false / style=false / scrim=false / bodyBg="rgb(20, 20, 20)"`。
cwe.log 卡在这三行之后 13 分钟零输出：
```
[01:01:01] info 已连上 Codex 主窗口
[01:01:01] info 当前文档的 CSP 拦截宿主，重新加载主窗口一次
[01:01:01] info 注入未完成(waiting-for-document)，0.8s 后重试（第 1 次）
```
机制（src/host/injector.mjs）：
- `prepareDocument`（:189-228）走 CSP 分支时设 `s.reloadingDoc = doc` 并发 `Page.reload`，返回 `"reloading"`；
- `sync`（:351-358）对 `"reloading"` **故意不排重试**，指望重载后的 `frameNavigated` 接力；
- 但 `frameNavigated` 在 re`load 之前就派过了；重载后新的 `domContentEventFired` 又被
  `s.reloadingDoc === s.doc` 守卫（:162）丢弃 → 两条接力路径全断 → 永久停在 waiting-for-document。

第二层：`watchTick`（:313-340）的 flush 判据只有账面比较
（`s.appliedDoc !== s.doc || s.appliedPayload !== lastPayload || !state.lastAppliedAt`），
`apply()` 也是直接 `return flush(s)` 不清账 —— 页面被清空但记账没清时，两边都认为「无事可做」，永远静默。

修复：
1. `apply()` 改为强制重推：先 `s.appliedDoc = null; s.readyDoc = null; s.panelSource = null; state.lastAppliedAt = 0;` 再 `flush(s)`。
   人按按钮 / 打接口就是要求真推一轮，不能因为记账说「已应用」而空返回。
2. `watchTick` 加运行时存活探针（每 10 秒）：页面里 `!!(window.__CWE && window.__CWE.version)` 不为 true 就清账重推，
   并记一条 `主窗口里找不到运行时（页面被重载或清空过），重新注入一次`。
   **账面不等于事实** —— 这条是这次最重要的教训。

### 验证（全部实测通过）
- `cwe stop` + `cwe start --detach` → 宿主 pid 19325 / http://127.0.0.1:55205，status「页面注入 已挂上 · image · 不透明度 100%」。
- 测试一（页面重载）：CDP 发 `Page.reload`，20 秒后 probe `hasCwe=true / ver=0.8.2 / root+style+scrim 全 true / bodyBg="rgba(0, 0, 0, 0)"`；
  cwe.log 出现 `检测到主窗口已重新加载，重新注入`。
- 测试二（运行时被清空但不重载）：`delete window.__CWE` + 移除 `#cwe-style/#cwe-root`，22 秒后自动恢复；
  cwe.log 出现 `主窗口里找不到运行时（页面被重载或清空过），重新注入一次`。**旧代码在这里会永久静默。**
- 看门人隔离实测（`CWE_DATA_DIR=/tmp` + 假 runtime 指向无人监听的 49321）：
  20 秒内只输出一条 `调试端口 49321 上没有端点…先不拉`，不拉宿主。★ 坑：第一次拿 9410 测，那个端口被别的 App 占着返回 200，
  `hostAlive()` 假阳，测不出问题 —— **验证「宿主不在」必须挑真没人监听的高位端口**。
- 截图 /tmp/cwe-shot3.png 确认壁纸铺满主窗口，侧栏半透明透出壁纸。

### 顺带修的两处
- `bin/cwe.mjs` `autostartStatus()` 的「另有 N 个来自其它副本的看门人在跑」是**误报**：
  旧代码 `ps` 输出里只要含字符串 `cwe-watch.mjs` 就算 foreign，而包住本命令的 `bash -c "... cwe-watch.mjs ..."` 自己就含这个字符串。
  改为新增 `watchProcesses()`：第一个 token 必须是 `node`、最后一个 token 必须就是脚本路径，才计入。`autostart off` 也用它，
  免得把外层 shell 一起 SIGTERM。
- `bin/cwe-watch.mjs` 的 `stamp()` 从 `toISOString()`（UTC）改成本地时间 —— watch.log 以前比 cwe.log 慢 8 小时，对照两份日志每次都要换算。

### 代码位置（下次改时直接跳）
- `src/host/injector.mjs`：`apply` ~394-399、`watchTick` ~313-340、`sync` ~342-392、`prepareDocument` ~189-228。
- `bin/cwe-watch.mjs`：`cdpAlive` ~167-173、`notify` ~175-191、`gracefulQuit` ~193-209、`tick` ~218-280。
- `bin/cwe.mjs`：`watchProcesses` ~779 起、`autostartStatus` ~808 起、`cmdAutostart` ~833 起。
- 备份：`.backups/local-fix-20261118/`（`cwe-watch.mjs.bak` 原始 / `.bak2` 二次改前；`cwe.mjs.bak` / `.bak2`）。
- 已同步到插件缓存 `~/.codex/plugins/cache/cwe/codex-wallpaper-engine/0.10.4/`（`bin/cwe-watch.mjs`、`bin/cwe.mjs`、`src/host/injector.mjs`）。

### 以后再出问题，三步自检
```
node bin/cwe.mjs status            # 守护 / 宿主 / 页面注入 / CDP 端口
node bin/cwe.mjs autostart status  # 看门人在不在跑、plist 在不在
ps -Ao command= | grep -c "ChatGPT --remote-debugging-port"   # 1 = Codex 带了端口
```
带上端口重启一次 Codex：`node bin/cwe.mjs launch`（会自己挑端口并打印）。
`页面注入 未挂上` 而现在 `watchTick` 的存活探针在跑 → 等 10 秒它自己会重推；还不行再 `cwe stop && cwe start --detach`。

## 2026-11-17 16:18 · 「插件不工作了」—— 注入永久停摆的三处根因（0.10.3 / panel 0.17.0 / runtime 0.8.2）

### 用户诉求
「现在 codex 壁纸插件好像不能正常在 codex 软件中运行了你修复一下」

### 现象
宿主活着（status 200 / inventory 10 张全 playable / 页面内 fetch 宿主 3–5ms 成功），
但页面里 `window.__CWE` 是 undefined —— 零注入。cwe.log 停在
`[07:57:32] warn 主窗口暂未注入: host-unreachable`，之后 8 小时没有任何新日志。
手动 `POST /wallpaper-engine/apply` 一次，画面立刻恢复 —— 说明链路本身是通的。

### 根因 1：一次失败 = 永久停摆（src/host/injector.mjs 的 sync）
旧 `sync(s)` 的 while 循环体**第一行**就 `s.appliedDoc = doc; s.appliedPayload = payload;`，
随后 ready 判定失败走 `continue` —— 而 while 条件正是 `(s.appliedDoc !== s.doc || s.appliedPayload !== lastPayload)`，
于是循环直接退出，**没有任何重试**。唯一的再触发点是 `domContentEventFired` / `frameNavigated`，
若失败发生在文档加载完成之后（本案正是），这两个事件永不重现 → 卡死。
另外 `reloadAttempts.add(target.id)` 之后判断 `has(target.id)` 永真 → 同一 target 只允许重载一次。

修法：
- **成功才记账**：把 `s.appliedDoc/appliedPayload` 的赋值挪到 `ensurePanel()` 返回 ok 之后
  （注释：「成功才记账 —— 这是整个自愈的前提」）。
- 新增 `scheduleRetry(s, doc, reason)`：退避 `Math.min(12000, 800 * 2^min(attempt-1,4))`，
  触发时若还是同一 doc 就清 appliedDoc/readyDoc/panelSource 再 flush。只在第 1 次和每 5 次记日志。
- 新增 `watchTick()`（`setInterval` 10s）：eval `performance.timeOrigin` 判断页面是否被重载，
  变了就 `s.doc++` 并清缓存重新注入；末尾发现 `appliedDoc !== doc` 就 flush —— 这条兜住了
  「页面重载但 CDP 没事件」的情况。
- `reloadAttempts` 改成按 `targetId#doc` 记账（`reloadKey` / `hasReloaded`），新文档允许再次自救。
- `prepareDocument` 的 reloading 分支加 10s 超时（`Date.now() - s.reloadAt < 10000`），
  防止 `Page.reload` 没生效时永远等下去。

### 根因 2：`<img>.decode()` 在本机永不 resolve（src/inject/runtime.js 的 swapMedia）
真机实验（同一张图，三种挂载位置：`#cwe-root` 的 slot / document.body / 不挂载）：
`decode()` **全部 PENDING>3s**，但三者 `complete` 全为 true；同一 URL 的 `load` 事件照常触发
（`load fired 1920x1080`）。不是 CSP、不是跨域、不是图坏。
旧代码只等 `decode()` → 每张图等满 20s `load-timeout` → `state.spec` 永远 null
→ `root.style.visibility = appearanceActive && state.spec ? "visible" : "hidden"` 停在 hidden
→ 壁纸空白。这就是「重新打开 Codex 后壁纸没了」的直接机制。

修法（图片路径，视频路径不动）：
```js
media.addEventListener("load", () => commitMedia(request), listener);
media.src = spec.url;
if (media.complete && media.naturalWidth > 0) {
  Promise.resolve().then(() => commitMedia(request));
} else {
  media.decode().then(() => commitMedia(request), () => {});
}
```
即 `load` 事件为主，`decode()` 降级为「不保证 resolve 的加速器」。

### 根因 3：注入后没人挂侧栏入口（src/inject/panel.js）
入口只在 `openPanel() → ensureMounted() → mountNativeEntry()` 路径里挂 —— 页面重载后
用户不点面板就永远没有壁纸按钮，只能判断「插件挂了」。真机复现：`Page.reload` 后
`entry` 连续 30 秒都是 false。

修法：新增 `bootEntry()` / `bootEntryWatch()`，注入即自举（nav 没渲染出来就 500ms 轮询，
最多 40 次），末尾 `bootEntryWatch()` 不等用户开面板；`destroy()` 里清 bootTimer。
挂上之后交给既有的 MutationObserver 看管。

### 附：单实例闸门（bin/cwe.mjs）
看守（cwe-watch）和我手动 `cwe start --detach` 会各拉一个守护，抢同一份 runtime.json，
页面被注入两遍、端口一会儿变一个。`cmdStart()` 的 detach 分支现在先 `readRuntime()` +
探一次 `/wallpaper-engine/status`（1200ms 超时），活着就打印「守护已经在跑 pid=…，不再起第二个」并返回。

### 真机验收（Codex 157.0.8103.78 / CDP 9333）
- 重启宿主后：`panel 0.17.0/native-13-boot-entry`、`runtime 0.8.2`、
  `spec {kind:"image"}`、`rootVis "visible"`、`media "ready"`、`entry true y=703 idx=2`。
- `Page.reload` 后采样：+1.5s…+7.5s 为 `rootVis hidden / entry false`，**+9.0s 全部自动就绪**
  （spec true / visible / entry true y=703 / ready），全程无人手动 apply。
- 截图 /tmp/cwe4/final-s.png（1300×738）：壁纸铺满、左侧栏底部「壁纸」在「用量」上方。
- `tools/test-renderer.mjs` 7 条全绿，含新增断言
  `✓ 宿主短暂不可达后自动恢复（无需手动 apply）`（宿主 503 后不再手动 apply，靠退避重试自己恢复，
  且断言 `loads()===3` 证明重试没有重载文档）。
- test-server / test-presets 24/24 / test-rotation / test-payload / test-faces 全过。

### 踩坑备忘（新增）
- `decode()` 在 Electron 渲染进程里可能永不 resolve，但 `complete` / `naturalWidth` / `load` 事件都正常
  —— 图片加载的收尾判据要用 `load`，别只等 `decode()`。
- 自愈的记账顺序必须是「成功才写 applied*」，提前写等于自己把重试开关关掉。
- 宿主 stop/start 后端口必变（本轮观察到 52670 → 56318），一律从 runtime.json 的 url 读。
- 看守会补位：杀守护前先杀 cwe-watch，否则 12–15 秒内又拉起一个。
- panel.js 已无 fp/version 守卫需要同步（injector 的 ensurePanel 只比内容哈希）。

## 2026-11-12 11:25 · 入口挂载修复 + 设置面板紧凑化（0.16.0）

### 用户诉求（两条）
1. 壁纸入口按钮位置不稳：刚开 Codex 时在「用量」上方，点一下壁纸图标就掉到「用量」下面。
2. 设置面板排版太散，要更紧凑。

### ① 挂载位置 bug —— 根因与修法
真机结构（Codex 157，nav[data-app-navigation-rail]）：nav 是 flex column，直接子元素只有
pointer-events-none 装饰层 / div.group.nav-list（六项导航）/ div.relative.shrink-0.w-9（底部叠层）。
底部叠层内部是 div.flex.flex-col.gap-2，里面依次是「用量」小容器、个人资料 div.flex.w-full。

- 旧算法从 profile 按钮往上爬，一遇到 `display:flex && flexDirection==="column"` 就 break —— 停在了
  那个 h124 的列容器上，随后 `profileHost.parentNode.insertBefore(b, profileHost)` 把它插进列里，
  所以视觉上落到「用量」下方。
- 另一处：早退守卫只要 navEntry 还在 nav 里就直接 return，位置永远固化在上次挂载点（旧实例留下的
  位置不会自我纠正），这才有「点一下位置就变」的观感。

修法：新增 `placeEntry(nav, b)`（src/inject/panel.js，位于 `var navEntry = null;` 之后、`mountNativeEntry()` 之前）
- 找最后一个 aria-label 匹配 /个人资料|profile/i 的 button；
- 一路 `while (stack.parentNode !== nav) stack = stack.parentNode;` 爬到 nav 的直接子元素（= shrink-0.w-9）；
- `nav.insertBefore(b, stack)`，并且只在「当前位置不对」时才动 DOM（b.parentNode !== nav || b.nextSibling !== stack）；
- 退路：插到 `button[data-sidebar-destination]` 之前 → 再退 nav.appendChild。
- mountNativeEntry 里原来那段爬 column + 三路 insertBefore 整段换成 `placeEntry(nav, b);`；
  早退守卫与 oldEntries 复用分支都先调 `placeEntry(nav, navEntry)` 再隐藏 launcher。

真机验证：entry y=699 / idx=2 / entryIsNavChild=true；用量 y=743；个人资料 y=787；三者等距 44px（36 + nav gap 8）。
连点壁纸图标 3 次，位置全部不变（y=699、idx=2）—— 漂移已闭环。

### ② 面板紧凑化 —— 五轮收敛到 0.16.0
量出来的病根：`.row` 40px 高 × 14 行；`.row .v` 拉满 514px 让滑杆过长；`input[type=range]{width:100%}`
在 flex 行里按整行算，轨道压过右侧数值；`max-width` 收窄后分隔线又比图集短一截。

最终值（关键几条）：
- `.card` 900×618（原 960×680）；`.nav` 168（@900 156 / @680 124）；`.body` padding 13px 16px 14px、gap 11
- `.row` `display:flex; align-items:center; gap:12px; padding:3px 2px 4px; min-height:30px`（无 max-width，与图集同宽）
- `.row .k` 136px / 12.5px / line-height 18；`.row .n` 46px + `margin-left:auto`（数值永远贴右）
- `input[type=range]` 由 `width:100%` 改为 `flex:1 1 auto; width:auto; min-width:0` —— 滑杆自己收缩，
  既不压数值也不留死区（中间试过 `max-width:380px`，会留一段明显空白，已回退）
- `.grid` minmax(160px,1fr) gap 8；`.drop` padding 7px 12px；`.sect` min-height 18；`.ftr` 30；
  `.sw` 30×17；`.face` 从纵向大卡改成横卡 `grid-template-columns:72px minmax(0,1fr)`（面积 226×66，原约 380 高）
- 长标签括号注释改走 `tip` → `title`：src/host/settings-schema.mjs 里 `pictureSlideSeconds`
  （label「轮换间隔」/tip「单位：秒；0 = 关闭轮换」）、`cweUiAlpha`（label「界面不透明度」/tip「越大越遮壁纸；调小就能看见更多本人」）；
  `fieldHtml()` 里 `'<div class="k"' + tip + ">"`。原先「界面不透明度（越大越遮壁纸）」在 136px 里折两行，
  把整行撑到 45px，竖排断格。
- 头像页三张资源卡横排后，一屏能同时看到卡片 + 6 行设置。

### 真机验收（panel 0.16.0 | native-12-face-row）
- entry y=699 / idx=2；连点 3 次稳定；card {x:285, y:106.5, w:900, h:618}
- 玻璃与界面页：14 行全部 30px 等高，`.k` 高 18px = 1 行，title 正确（折行消除）
- 头像页：`.face` 226×66、`.pv` 72×41
- 截图（仓库内留档）：docs/shot-entry-0.16.0.png（侧栏底部三图标：壁纸 / 用量 / 头像）、
  docs/shot-panel-0.16.0.png（玻璃与界面页）、docs/shot-avatar-0.16.0.png（头像页横向资源卡）

### 回取指针
log:session-46ddaccf-1d8f-47d4-9ba6-0f5f63bf3a95#seq=m00218（真机量 body/row 尺寸那一轮）


## 本轮（m02287）四项 —— 全部完成

### ① 删除已上传壁纸
- wallpaperTab()：tile 由 `button[data-id]` 改为 `div.tile`，内包 `.hit[data-id]`（铺满，选用）+ `.del[data-tile-del]`（右上 22×22，icon("trash")）
- 外层必须是 div：button 套 button 会被 HTML 解析器甩开
- `.lbl/.typ/.check` 全部 pointer-events:none，否则当住 .hit 的点击（真机踩到：elementFromPoint 返回 DIV，点图不换壁纸）
- .check 从右上挪到左下（left:7px;bottom:7px）避让；.lbl 右 padding 30px
- 新增 removeWallpaper(id)：confirm 含文件名 + 「不能撤销」；删当前选中项时先 POST /settings 切到下一张再 loadAll（顺序反了会黑一帧）
- onClick 里 data-tile-del 分支必须排在 data-id 之前
- 走宿主 POST /wallpaper-engine/remove（server.mjs:161 handleRemove），与 `cwe remove <id>` 同一路径

### ② 排版再美化（克制档，只动真实缺陷）
- .row:hover / :focus-within 由 transparent 改成 var(--hover)（原来悬停等于没有反馈）
- .sect min-height:26px + margin-top:4px（区块标题与内容拉开节奏）
- .navgroup letter-spacing:.02em
- .card[data-thin="1"] .nav 补底 rgba(var(--base),.26)：46% 通透档下侧栏文字会被背后亮壁纸吃掉

### ③ 兼容性
- 字体栈补齐：PingFang SC / Hiragino Sans GB / Microsoft YaHei / Noto Sans CJK SC / Source Han Sans SC / Noto Sans SC / system-ui
- .card 追加 height:min(680px, calc(100dvh - 72px))（旧引擎忽略即回退到 vh）
- @supports not (aspect-ratio:16/10) → .tile height:0; padding-bottom:62.5%
- 新建 src/host/app-path.mjs：findAppBinary() / describeSearch()，mac+win+linux 候选表，CWE_APP_BIN 可覆盖
- bin/cwe.mjs cmdLaunch 与 bin/cwe-watch.mjs 改用 findAppBinary()；watch 的进程扫描加空串守卫（!APP_BIN 直接跳过，否则 indexOf("") 恒为 0 会把整机进程当 Codex）

### ④ 监听/调试端口
- 新建 src/host/port-pick.mjs：portListening / pickCdpPort / describePick / clampPort
  · 先扫 cwePort..+11 找已存在的 DevTools 端点 → 复用（重启守护的常态）
  · 否则取第一个真正空闲 → free；全占 → busy 仍回 preferred
- daemon.mjs：启动前 pickCdpPort，注入器用得到的 cdpPort，writeRuntime 增加 cdpPortPreferred / cdpPortState
- daemon.mjs：readOwnVersion() 读 package.json 取代写死的 "0.4.2"
- server.mjs listen() 重写：单个 error handler + settled + cleanup，不再叠加监听泄漏；固定端口被占明确 reject，不再盲目 +1 试到 9345

## 回归（全绿，exit 0）
- node --check：panel.js / runtime.js / injector.mjs / daemon.mjs / server.mjs / port-pick.mjs / app-path.mjs / bin/cwe.mjs / bin/cwe-watch.mjs
- tools/test-server.mjs → SETTINGS groups 10 version 8 / INV 15（image13+video2）/ MEDIA 206 / CLOSED
- tools/test-presets.mjs → RESULT 24/24
- tools/test-rotation.mjs → ROTATION_TEST_PASS（ok1-ok5 全 true）
- tools/test-payload.mjs、tools/test-faces.mjs → 全过

## 真机验收（CDP 9333，主 target app://-/index.html）
- panel 0.13.0|native-6-tile-hit；tiles 15 / hits 15 / dels 15；card 960×680；body scrollW 770 = clientW 770（无横向溢出）
- 真实鼠标点 tile 中心 → 壁纸切到 up-mvyvw80n-vrbktj（changed:true）；点删除按钮 → confirm 正确弹出
- 悬停 tile → .del opacity 1；删除按钮 22×22 右上内缩 7px
- 事后已把用户原选中的壁纸用 POST /settings 还原为 up-mvw4ivjx-mo9gzc
- 截图：/tmp/cwe-013-hover.png、/tmp/cwe-final-panel.png、/tmp/cwe-v13-panel.png

## 踩坑备忘
- CSS 是 panel.js 里**单个 JS 字符串字面量**（行号会漂，2026-11-12 时在 687 附近）：改动必须走「扫引号 → eval 解字面量 → 改 → JSON.stringify 回写」，脚本先 write 到 /tmp/*.cjs 再 node 跑，别用 bash 内联（转义会被剥）
- 补丁脚本匹配 CSS 别用固定字符串（里面有换行会失配）：把目标串按空白切成 token、逐个正则转义、再用 `\s+` 连成 RegExp，`css.replace(rx, to)` —— 这套 /tmp/cwe/patch-css*.cjs 一直好用
- 改 CSS/结构必须同时升 FP，并同步 src/host/injector.mjs:273 的守卫字符串，否则页面旧实例不换
- **改 injector.mjs:273 守卫时注意盘上是 `\'` 转义写法**：`str.replace("'0.15.0'", ...)` 不命中，只改一半（fp 变了 version 没变）会让 injector 认为面板已死、反复重注入。用 python 匹配 `\\'0.15.0\\'` 才稳。
- **真机重载面板别再手工 teardown**：直接 `curl -X POST $BASE/wallpaper-engine/apply -d '{}'`，宿主 injector 会重注入 runtime.js 再 ensurePanel()。手工路径只作兜底，且只 `delete window.__CWE.panel` / `openPanel`，**绝不能 delete window.__CWE**（panel.js:16-17 会 `if (!CWE) return;`，之后什么都不建）
- 宿主 stop/start 后**端口会变**（49221 → 59100），URL 一律从 `~/.codex-wallpaper-engine/runtime.json` 的 url 读，别写死
- 改 settings-schema 的 label / tip 必须重启宿主才生效（panel 从 /settings 拉 GROUPS）
- 测试拖 range 必须补派发 change，否则 state.dragging 卡住后续 paint

## 已知未做（用户没要求）
- 面板无「批量删除 / 清空清单」入口
- Windows / Linux 的 app 路径只有候选表，未实机验证

---

## 2026-11-10 20:43 · 玻璃重做一轮（进行中，已暂停待压缩）

### 触发
用户看过 0.13.0 面板后说玻璃「违和」，要重新融入壁纸（玻璃这一轮）。

### 已实测到的现状（真机 CDP，panel 0.13.0 / FP native-6-tile-hit）
- card computed: background rgba(24,24,24,0.59)、backdrop-filter blur(3px) saturate(1.25) brightness(1.02)
- .scrim rgba(0,0,0,.20)；.nav rgba(127,127,127,.043)
- 截图 /tmp/cwe-glass-before.png

### 诊断（三条，都指向"不像玻璃"）
1. 模糊只有 3px —— 壁纸的文字与线条细节直接透上来，观感是"脏"不是"磨砂"
2. 底色是中性灰 24,24,24、saturate 1.25 —— 玻璃发灰，和背后偏暖壁纸脱节，没有环境色渗透
3. 内高光只有 inset 0 1px 0 rgba(255,255,255,.06)、无外描边层次 —— 没有厚度，像一块塑料贴片
4. 额外：.scrim 纯黑 20% 叠在壁纸与编辑器之间，制造第二层灰

### 已完成的准备工作
- CSS 已从 panel.js 抽出到 /tmp/panel.css（289 行 / 18760 字符），抽取脚本 /tmp/cwe-extract-css.mjs（扫 var CSS = ...; 后 eval 字面量）
- 关键行：.card 在 CSS 第 45-56 行；.scrim 44 行；.nav 75-76 行；data-thin 57-58 行
- 玻璃两键的消费点：src/inject/panel.js:1347 applyGlass()，写 --ga / --gb / data-thin，调用点 229/282/413/533/1191/1964

### 下一步（未开工）
1. 重写 .card 玻璃配方：blur 提到 20-26px、saturate 1.6-1.8、brightness 1.03-1.06；底色改成带暖偏的 rgba；补双层内高光（上 1px 亮 + 下 1px 暗）+ 外层 1px 亮描边
2. .scrim 从纯黑 20% 降为 8-12%，或改成径向渐晕，去掉第二层灰
3. 三档（通透 46%/26px、标准 74%/18px、厚实 94%/10px）在满足对比度前提下重排数值
4. 改完必须：panel.js VERSION 升到 0.14.0、FP 升（native-7-glass-real）、同步 src/host/injector.mjs:273 守卫字符串、package.json 与 .codex-plugin/plugin.json 升 0.9.0
5. 回归：node --check + tools/test-server.mjs / test-presets.mjs / test-rotation.mjs；真机 CDP 复验 + 截图；node tools/pack.mjs

### 阻塞
本轮思考熔断（延续额度耗尽），需要手动压缩后再继续。

### 回取指针
log:session-39295f82-5769-454a-806a-a70716660629#seq=2747（玻璃现状实测那一轮）


---
name: wallpaper-engine
description: "Codex 桌面端壁纸引擎。当用户想给 Codex 换壁纸、让界面变半透明/液态玻璃、调整壁纸不透明度或模糊、开点击特效与鼠标视差、改头像，或问「壁纸怎么不显示」「Codex 太黑想换个背景」时使用。也用于把本机图片/视频设成壁纸、管理壁纸库与轮播。"
---

# 壁纸引擎

`<skill-dir>` 是本 SKILL.md 所在目录；相对路径都从它解析。

这个插件在 Codex 主窗口的 body 最前面插一层 z-index 最低的壁纸容器，并把 Codex 自己的背景壳降成半透明——于是壁纸从界面之后透出来，侧栏、正文、输入框全都照常能读能点。不改 app.asar，不动任何原生功能。

## 先决条件：Codex 必须带调试端口

壁纸层是运行时注入的，需要 Codex 以 `--remote-debugging-port=9333` 启动。用户平时点的那个图标没有开端口，所以：

1. 先跑 `wallpaper_status`，看页面有没有连上。
2. 没连上就跑 `wallpaper_launch_codex`。它会用新实例带端口启动，并保留用户原来的窗口。
3. 等 5–10 秒再跑一次 `wallpaper_status`。

宿主守护进程不用人管：任何工具调用都会先自己探活，没跑就自动 detach 一个 `bin/cwe.mjs start`，最多等 15 秒。

### 一次配好，以后点 Dock 也有壁纸

上面三步只管这一次。要一劳永逸，开一次自启（macOS）：

```bash
node bin/cwe.mjs autostart on      # 装 launchd 看门人
node bin/cwe.mjs autostart status  # plist 装了没 / 加载没 / 看门人在不在
node bin/cwe.mjs autostart off     # 关掉
```

看门人 `bin/cwe-watch.mjs` 常驻，盯着 Codex 进程：发现新起的实例没带 `--remote-debugging-port`，就用同一份二进制带端口重启一次。于是用户随手点 Dock 图标，壁纸也会出现。它不走 HTTP，也没有对应的 MCP 工具 —— 只能从 CLI 调。

注意：排查时如果 `wallpaper_status` 显示页面没连上，但自启是开的，先怀疑看门人自己挂了（`autostart status` 第三行），而不是 Codex 没开端口。

## 工具

| 工具 | 干什么 |
|---|---|
| `wallpaper_status` | 一切排查的起点：宿主在不在、页面挂上没有、当前壁纸是哪张 |
| `wallpaper_list` | 列出壁纸库（type 可筛 video / image，limit 默认 60） |
| `wallpaper_use` | 设为当前壁纸，立刻生效。id 也接受 next / prev / random |
| `wallpaper_get` | 读配置，不带 key 读全部 |
| `wallpaper_set` | 改一个或多个配置项，立刻生效并持久化 |
| `wallpaper_panel` | 在 Codex 窗口里弹出设置面板 |
| `wallpaper_upload` | 把本机图片/视频加进壁纸库并设为当前。单文件上限 2GB，服务端边收边写盘（`.part` → rename），超限或断连会清掉半截文件；被 413 挡住时返回的 error 里带 `(max 2GB)` |
| `wallpaper_remove` | 删掉上传的壁纸（id 以 up- 开头） |
| `wallpaper_apply` | 把当前配置重推一次（页面刷过、壁纸层丢了时） |
| `wallpaper_launch_codex` | 带调试端口启动 Codex |
| `wallpaper_rotation` | 轮播组：status / create / update / delete / add / remove / use / enable |
| `wallpaper_preset` | 外观预设：list / save / apply / delete / export / import |
| `wallpaper_mascot` | 吉祥物：status / set（传本地 png/jpg/webp）/ clear |
| `wallpaper_avatar` | 头像：status / set / clear，side=user 或 ai |
| `wallpaper_fontset` | 字体集：list / get / use / delete |
| `wallpaper_system_fonts` | 扫系统字体清单（refresh=true 强扫） |

## 配置键（wallpaper_set 能改的）

**壁纸本体**
- `wallpaperOpacity` 0–100，壁纸层不透明度。默认 100（完全显示）。它和界面透明度是两个扣分点，两边都降会双重变暗 —— 想「隐约透出」就调界面那边
- `scrim` 0–1，压在壁纸上的黑遮罩。默认 0。字看不清就加这个，别急着降 opacity
- `backgroundBrightness` 0–200 / `backgroundContrast` 0–200 / `backgroundSaturate` 0–300，只作用壁纸层
- `wallpaperBlur` 0–40 px，整层模糊
- `objectFit` cover / contain / fill / none / scale-down
- `layerPositionX` / `layerPositionY` 0–100 %，壁纸焦点位置
- `layerScale` 10–400 %，放大壁纸
- `flip` 水平翻转
- `switchTransition` cut / fade / slide / zoom / wipe，换壁纸的过场
- `rotationEnabled` + `pictureSlideSeconds` 自动轮换

**界面透明度（决定壁纸能透出多少）**
- `cweUiAlpha` 0–1，界面整体遮挡度（默认 0.66）。它就是「肉眼看到挡住壁纸多少」，不是某一层自己的值 —— 注入层会把这个数在嵌套容器之间做「补差值」，不会连乘。1 = 完全不透，0.4 以下壁纸非常抢眼
- `cweUiAlphaMain` 0–1，外层 MAIN 壳的不透明度（默认 0.58）。比 cweUiAlpha 小时，主壳更透、内容面补上差额，合成结果仍是 cweUiAlpha
- 这两个和 `wallpaperOpacity` 是两个方向：wallpaperOpacity 是壁纸自己淡，cweUiAlpha 是界面透。想让壁纸清楚而文字照读，把 cweUiAlpha 调低、sidebarAlpha 补上，别两边一起降

**玻璃**
- `sidebarGlass` / `sidebarBlur` / `sidebarAlpha` 控制左侧图标栏。旧布局仍用它们调整整块侧栏。
- `conversationSidebarGlass` / `conversationSidebarAlpha` / `conversationSidebarBlur` 独立控制左侧项目与会话列表。默认 70% 不透明度、18 px 模糊，可在「玻璃与界面」调整。
- `sidebarEdgeBlend` 侧栏右缘那条 20px 接缝：默认 `false` 直接抹掉（Codex 原生用 `::after` + `background:inherit` 画它，继承了半透明色却没有 backdrop-filter，所以看着比侧栏更亮）；`true` 给它补同款背景 + 模糊
- `titlebarGlass` / `titlebarTransparency` / `titlebarBlur` 控制顶栏
- `rightSidebarGlass` / `rightSidebarTransparency` / `rightSidebarBlur` 控制右侧面板
- `overlayGlass` / `floatersTransparency` / `floatersBlur` 控制匹配到的菜单、搜索、弹窗和会话摘要
- `composerGlass` / `composerAlpha` / `composerBlur` / `composerRadius`，输入框玻璃（输入区）
- `composerChipGlass` / `composerChipAlpha`，输入框上方那行「选择项目 / 此计算机」chip —— 只开输入区会在玻璃顶上留一条深灰实心块，所以两层默认都开
- `composerPillGlass` / `composerPillAlpha`，输入框右下角「模型 / 权限」胶囊（`div[class*="composer-layout-surface"]`，原生底色走 CSS 变量 `--composer-layout-surface-background`）
- `codeGlass` / `codeAlpha` / `codeBlur` / `codeRadius`，GPT 回复里的代码块：本体 `Root-iW7ipz`（原生 `rgb(40,40,40)` + 8% 白渐变）与顶栏 `ActionBar-KWWAct` 两层，开玻璃时顶栏自动置透明
- `writingGlass` / `writingAlpha` / `writingBlur`，写作区域（Writing 可编辑卡片）：外层 + 垫底层 + header 三层一起改，只改外层会在玻璃上压一块深灰
- `bubbleGlass` / `bubbleAlpha` / `bubbleBlur`，我发给 Codex 的消息气泡（`div[class*="bg-user-message"]`，原生 `rgb(23,62,118)` 深蓝 + 22px 圆角，内部没有实色子层）—— 保留原生蓝，只放出不透明度
- `accent` 强调色（十六进制），同时喂给特效与面板
- `extraGlassSelectors` 逐行写额外选择器（每行要含 `{`）

**特效与动态**
- `fxEnabled` / `fxClick` / `fxClickStyle`（ripple/burst/ring/star）/ `fxClickSize`
- `fxTrail` / `fxTrailStyle`（comet/line/dots/spark）/ `fxTrailLength` / `fxTrailWidth`
- `fxOpacity` / `fxBlend` / `fxColorMode`（accent/custom/rainbow）/ `fxColor`
- `parallaxEnabled` / `parallaxBg`（0–5，壁纸跟随鼠标的位移强度）/ `parallaxUi` / `parallaxSmooth`
- `avatarEnabled` / `avatarSize` / `avatarRadius` / `ropeShown` / `ropeScale`

**宿主**
- `cweEnabled` 总开关；`cweInjectOnStart` 启动即注入；`cwePort` 调试端口（默认 9333）

## 常见任务

**换一张壁纸，顺便让字更好读**
1. `wallpaper_list` 挑一张（或 `wallpaper_upload`）
2. `wallpaper_use` 设上
3. `wallpaper_set {"cweUiAlpha": 0.55, "scrim": 0.2, "sidebarAlpha": 45}` —— 遮挡靠界面 alpha 与 scrim 两个杠杆，别同时把 wallpaperOpacity 也降下去（两个扣分点叠加会把图压黑）

**做成液态玻璃风**
`wallpaper_set {"cweUiAlpha": 0.55, "cweUiAlphaMain": 0.6, "sidebarGlass": true, "sidebarBlur": 18, "sidebarAlpha": 62, "titlebarGlass": true, "accent": "#67DCE7"}`

**太花，看不清字**
先加 scrim（0.4–0.55），再把 backgroundBrightness 压到 70–80、wallpaperBlur 给 8–16。不要直接把 wallpaperOpacity 砸到 0——那等于关掉壁纸。

**在三种气质之间一键切换**
用 `wallpaper_preset`。随包三套：
- `clear-max` 全通透：界面 α 0.28 / 壁纸 100%，壁纸最清楚，适合图片和视频
- `glass-dark` 午夜玻璃：α 0.62 / 壁纸 60% / 模糊 6px，深色壁纸下最稳
- `plain` 原生观感：α 0.97 / 壁纸 0%，等于临时关掉，随时能回来

`{"action":"apply","id":"glass-dark"}` 应用；`{"action":"save","name":"我的观感"}` 把当前这套存下来。
预设只打包外观键（49 个），端口、上传目录、隐藏列表、轮播组不会被带走。

**让壁纸自己换**
- 图集轮播：`wallpaper_set {"rotationEnabled": true, "pictureSlideSeconds": 30}`
- 轮播组：`wallpaper_rotation {"action":"create","name":"工作","interval":20,"order":"random"}` 再 `{"action":"add","id":"<组id>","wallpaperId":"<壁纸id>"}`，最后 `{"action":"enable","enabled":true}`
- `trigger: "videoEnd"` 是「当前视频播完就换」，适合视频壁纸；`"interval"` 按分钟

**要能自己调**
`wallpaper_panel`。面板十二个分页：壁纸 / 轮播 / 预设 / 玻璃与界面 / 输入框 / 代码块 / 写作与消息 / 特效 / 视差 / 头像 / 字体 / 宿主，改动即时生效。用户也可以按 ⌥⌘W（Windows 为 Alt+Ctrl+W）唤出。

## 硬约束（改代码时别破坏）

- 注入只碰 body.firstChild 之前的壁纸容器与一层 style，绝不重排 Codex 的 DOM 树。
- 只有确认当前文档的 CSP 拦了本机状态请求时，才对该主窗口重载一次。等待主界面和媒体就绪后再应用透明样式。
- 只注入主窗口 `app://-/index.html`；avatar-overlay 与 detached-window 两个副窗不碰。
- `autostart` 只写 `~/Library/LaunchAgents/` 下的一个 plist，不碰系统其它位置。`off` 必须先查 `launchctl list` 再决定要不要 unload —— 对没加载的 label 调 unload 会把 `Input/output error` 打到用户终端。

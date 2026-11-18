# Codex 桌面窗口适配

`src/inject/runtime.js` 中的 `surfaces` 是渲染和诊断共用的选择器表。优先使用 Codex 的结构属性，旧构建通过组件类名前缀识别。加载屏未呈现主内容面时，页面维持原生外观。

| 区域 | 主要结构 |
| --- | --- |
| 外壳 | `#root [data-app-shell-frame]`，旧布局使用 `PageSurfaceLayout-` 组件 |
| 内容面 | 外壳内的 `[data-app-shell-main-surface]` 或 `MainContentSurface-`。内层只补外壳和目标遮挡度之间的差额 |
| 顶栏 | 外壳内的 `[data-app-shell-titlebar]`，旧布局使用 `header.h-toolbar` |
| 左侧图标栏 | 左栏内的 `nav[data-app-navigation-rail]`。旧布局由整个 `aside.app-shell-left-panel` 承载玻璃 |
| 左侧会话列表 | 左栏内的 `[data-sidebar-navigation-root]`。贴边展开时由其下的 `[data-slate-sidebar-content]` 承载玻璃 |
| 右侧面板 | 外壳内的 `[data-app-shell-focus-area="right-panel"]` |
| 输入框 | `[data-composer-body]` 和 `[data-composer-surface-variant]`。上方工具条、胶囊与底部背景清理限定在输入框范围 |
| 代码块 | 带独立工具条和 `[data-code-block-source]` 的代码容器，兼容旧版 `Root-iW7ipz` |
| 写作与消息 | `.writing-block-surface` 和 `.bg-user-message` |
| 搜索、弹窗与菜单 | 搜索命令框、带原生表面标志的对话框与菜单、Radix 的 Popover 容器 |
| 会话摘要 | 带 `group/summary-panel` 标志的原生浮层表面 |

## 验证 Codex 更新

用带调试端口的 Codex 打开一个会话，运行以下只读检查。macOS 会同时报告已安装的 Codex 应用版本。端口以当前宿主为准，也可以传 `--port`。

```bash
node bin/cwe.mjs check --json
```

`shellReady` 表示当前文档有已显示的主界面。`matches` 列出每类表面的总命中数和可见命中数。打开右侧面板、搜索、菜单和弹窗后分别检查，关闭的浮层可能没有 DOM 节点。`backdropFilter` 表示渲染器是否支持背景模糊。

若新版改了结构，在对应页面核对承载背景的节点，更新 `surfaces` 中的候选选择器。确认主壳、会话、输入框和浮层都能命中，检查原生按钮、列表选中态、键盘输入和浅色主题。系统开启「减少透明度」时使用原生表面。主壳的匹配失效时保留原生外观，单个浮层匹配失效时该浮层使用原生样式。

新版的 `app://-/index.html` 也能打开头像浮层。主窗口检查和注入根据 `initialRoute` 排除这些副窗。

用无头 Chrome 验证启动、CSP、慢媒体、过渡和结构兼容。测试使用临时用户目录和独立端口。

```bash
npm run test:renderer
# Chrome 装在自定义路径时
CWE_TEST_CHROME="/path/to/chrome" npm run test:renderer
```

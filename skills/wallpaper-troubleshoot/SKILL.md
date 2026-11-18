---
name: wallpaper-troubleshoot
description: "排查 Codex 壁纸引擎不生效的问题：壁纸是黑的或没出现、界面全黑看不见字、Codex 更新后壁纸消失、面板打不开、上传失败、换壁纸没反应、宿主端口冲突。当用户说「壁纸没显示」「Codex 变全黑」「面板打不开」时使用。"
---

# 壁纸引擎排障

`<skill-dir>` 是本 SKILL.md 所在目录；相对路径都从它解析。

## 排查顺序（别跳步）

**第一步：wallpaper_status**
一次调用就能区分四种状态：

| 看到什么 | 意思 | 下一步 |
|---|---|---|
| 宿主起来了，页面 connected 是 true | 一切正常 | 问题在参数，跳第五步 |
| 宿主起来了，connected 是 false | Codex 没开调试端口 | 跑 wallpaper_launch_codex，等 10 秒 |
| 返回 daemon: "起不来" | 宿主进程挂了 | 看 ~/.codex-wallpaper-engine/cwe.log 尾部 |
| 连不上宿主 | runtime.json 过期（进程被 kill 没清文件） | cwe stop 再 start |

**第二步：确认 Codex 真有那个端口**
`curl -s http://127.0.0.1:9333/json/version` 应该返回 JSON。没有就是没开端口。
Codex 可以多开：带端口的那份是独立实例，用户原来那份仍然没有端口。壁纸只画在带端口的窗口上。

**第二步半：自启开着却没端口？先怀疑看门人**
如果用户开了 `cwe autostart on`，理论上点 Dock 也会带端口。此时端口不通，八成不是 Codex 的问题，而是看门人自己没了：

```bash
node bin/cwe.mjs autostart status
```

三行分别看：plist 在不在、launchd 加载没、看门人进程活着没。常见三种坏法：

| 现象 | 原因 | 处理 |
|---|---|---|
| plist 不在 | 从没开过自启，或 `autostart off` 过 | `autostart on` 重装 |
| plist 在、未加载 | 被手动 `launchctl unload` 过 | `autostart off` 再 `on`（重新 load） |
| 加载了、进程不在 | 看门人崩了 | 看 `~/.codex-wallpaper-engine/watch.launchd.log`；`KeepAlive` 会在 10 秒后自动重拉，等一会儿再 `status` |

看门人只做一件事：给裸启动的 Codex 补 `--remote-debugging-port`。它挂了不影响壁纸层本身，只影响「点 Dock 也有壁纸」这条路径 —— 临时用 `wallpaper_launch_codex` 手动起一次即可。

**第三步：看日志**
`~/.codex-wallpaper-engine/cwe.log`。关键词：
- `已连上 Codex 主窗口` 正常
- `injector.start 失败` CDP 连不上
- `面板注入失败: panel: SyntaxError` 面板源码被包了多余括号（历史 bug，已修）
- `注入失败(...)` 运行时抛错，后面跟具体消息

**第四步：页面刷过 / Codex 更新过**
页面重载后宿主会自动同步新文档。用 `node bin/cwe.mjs check --json` 查看 Codex 版本、主壳识别和当前页面的选择器命中。先打开对应菜单、搜索或右侧面板再查这些区域。主壳无法识别时，插件保留原生外观。

**第五步：参数问题**
- 壁纸是黑的 → wallpaperOpacity 是不是 0；cweEnabled 是不是 false
- 界面全黑看不见字 → cweUiAlpha / cweUiAlphaMain 太低（< 0.35）或 scrim 太高（> 0.75）。调回 cweUiAlpha 0.8、scrim 0.15
- 壁纸一片糊 → wallpaperBlur 太大
- 换壁纸没反应 → 清单里那张 id 是否存在（wallpaper_list 核对）

## 已知的坑（写代码时别重犯）

1. `Page.setBypassCSP` 需要新文档才能解决旧文档的拦截。遇到确认的 CSP 拦截，注入器最多为当前主窗口 target 重载一次。端口故障和普通网络错误按连接问题排查。
2. **panel.js 自身就是完整语句，末尾带分号。** 再包一层 (...)() 会变成语法错 Unexpected token ';'。直接 eval 源文件。runtime.js 相反，结尾无分号，必须包 (src)(payload)。
3. 双槽在新媒体已解码后交接。`cut` 同一帧释放旧槽，其它过渡在完成时释放。快速切换或关闭时取消未完成的媒体请求。
4. **宿主端口每次重启都会变。** 壁纸 URL 里带 token，但 origin 变了旧 URL 就失效，所以重启宿主后必须重推 payload。
5. **缓存不能存 token。** token 只活在内存 Map 里，重启即失效。
6. **只绑 127.0.0.1。** 对外 URL 一律带 token，清单里绝不出现真实路径。
7. **清单只有一个数据源：上传目录。** 不扫任何第三方软件目录，所以「壁纸库里没有某张图」只有两种原因：没上传，或上传目录被改到了别处（看 `wallpaper_get` 的 `uploadDir`）。

## 恢复原样

- 临时关掉壁纸：`wallpaper_set {"cweEnabled": false}` —— 页面立刻回到原生外观
- 摘掉开机自启与看门人：`node bin/cwe.mjs autostart off`（不摘的话，它会把 Codex 再带端口拉起来）
- 完全卸载注入：`node bin/cwe.mjs uninstall`
- 停守护：`node bin/cwe.mjs stop`
- 恢复默认配置：`node bin/cwe.mjs reset`
- 数据目录：`~/.codex-wallpaper-engine/`（配置、上传、缓存、日志都在这里；删掉等于重置）

Codex 本体全程没被改动，所以任何一步出错都能靠「关掉守护 + 刷新窗口」回到干净状态。

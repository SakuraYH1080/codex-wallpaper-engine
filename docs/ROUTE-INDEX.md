# 路由索引

宿主 HTTP 服务只绑 `127.0.0.1`，端口由 `listen(0)` 自动分配（每次启动都会变，落在 `~/.codex-wallpaper-engine/runtime.json`）。所有对外 URL 带内存 token，清单里绝不出现真实路径。

前缀统一是 `/wallpaper-engine`。下表的 `<token>` 指 `createTokenStore().tokenFor()` 铸的 18 位十六进制串。

## 清单与媒体

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/inventory` | 壁纸清单。只扫上传目录，内存 TTL 5s，重扫单飞。返回 `{version:3, uploadDir, cacheDir, total, portableCount, counts, wallpapers[]}` |
| GET (`token`) | `/media/<token>` | 壁纸本体（图片/视频）。支持 Range / HEAD / 条件 GET |
| GET (`token`) | `/preview/<token>` | 预览图 |

## 配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | `{version, config, defaults, groups, configPath, uploadDir, cacheDir, dataRoot}` |
| POST | `/settings` | 体 ≤ 64 KiB。`{patch}` 经 `sanitize()` 后落盘并推 payload；回 `{ok, config}` |
| DELETE | `/settings` | 恢复默认（先备份成 `config.json.bak-<ts>`） |
| POST | `/apply` | 可选体 `{patch}`；把最新配置重推一次给页面 |
| GET | `/status` | 守护/页面/清单计数器快照 |
| POST | `/panel-open` | 让页面里的设置面板弹出 |
| POST | `/rotation-next` | 视频播完时由页面回调，触发轮播推进 |
| GET | `/diag-log?n=80` | 内存里的错误环（最多 50 条） |

## 上传

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/upload?name=&title=` | 体上限 512 MiB。扩展名白名单 `mp4/webm/jpg/jpeg/png/gif/webp/avif`，其余 400；空体 400 |
| POST | `/remove` | 体 `{id}`，id 必须匹配 `/^up-[a-z0-9-]+$/i` |
| GET | `/upload-dir` | 当前上传目录 |
| POST | `/upload-dir` | 改上传目录（持久化到 config，重启不回退） |
| GET | `/cache-dir` | 缓存目录与占用 |

## 用户资源面（不用 token）

内容变了文件名就变（`stamp()` = 时间戳 base36 + 4 位随机），所以路由给 `immutable` 缓存，不会拿到旧图。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/HEAD | `/mascot` | 吉祥物图。未设置 404 `{ok:false,error:"not-set"}` |
| POST | `/mascot` | 上限 8 MiB，Content-Type 只认 image/jpeg / image/png / image/webp（否则 415）；空体 400 |
| DELETE | `/mascot` | 删当前 |
| GET/HEAD | `/avatar/<side>` | `side` ∈ `user` / `ai`，其余 404 `{ok:false,error:"bad side"}` |
| POST | `/avatar/<side>` | 同 mascot 的格式与大小约束 |
| DELETE | `/avatar/<side>` | 删当前 |
| GET | `/fontsets/list` | `{ok, fontsets:[{id, source, name, values}]}`（字段名是 `fontsets`，不是 `sets`） |
| GET | `/fontsets/get/<id>` | 单套；`..%2F` 之类的穿越尝试 404 |
| PUT | `/fontsets/put/<id>` | 写用户层（写时复制：随包层只读） |
| DELETE | `/fontsets/delete/<id>` | 删用户层；随包层 409 `{ok:false,error:"not-user-layer"}` |
| POST | `/fontsets/activate/<id>` | 设为当前（写 `config.fontSetId`） |
| GET | `/fontsets/export/<id>` | 导出 JSON |
| POST | `/fontsets/import` | 导入 |
| GET | `/system-fonts` | 系统字体清单。`?refresh=1` 强扫。异常也回 200 `{ok:false,fonts:[],source:"error"}` |

## 外观预设

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/presets` | `{ok, presets, keys, current}`。`keys` 是外观键白名单（49 个），`current` 是当前配置的外观子集 |
| POST | `/presets` | 体 `{name?, values?}`。`values` 省略时取当前配置的外观子集（「把现在这套存下来」） |
| POST | `/presets/import` | 体 `{preset, name?, apply?}`。导入先过 `sanitize()` 再落盘，`apply !== false` 时立刻应用 |
| GET | `/presets/<id>` | 单套 |
| GET | `/presets/<id>/export` | `content-disposition: attachment; filename="cwe-preset-<id>.json"` |
| POST | `/presets/<id>/apply` | 应用：`updateConfig(values)` + 清单失效 + 推 payload |
| DELETE | `/presets/<id>` | 删用户预设；内置 409 `{ok:false,error:"not-user-preset",builtin:true}` |

**分流纪律**：`/presets` 的 POST 只认两条路 —— `""`（保存）与 `import`（导入）。曾经把 POST 一律丢给保存分支，结果 `POST /presets/<id>/apply` 被当成保存，凭空造出脏预设。所以 `server.mjs` 里按 `rest.split("/")` 精确判 `isApply`。

## 清单行字段

`wallpapers[]` 每行的公共字段：`id / title / type / contentrating / schemeColor / source('upload') / hidden / playable`。

按类型追加：

- **video**：`media`、`mime`（`video/mp4` 或 `video/webm`）
- **image**：`media`

`preview` 最后统一写（防止被各分支的 `null` 覆盖）；`frameUrl` / `propsUrl` 恒 `null`（dsh 版有，本项目未实现逐帧预览）。

## MCP 工具 → 路由映射

`mcp/server.mjs` 的 16 个工具最终都打到上面这些路由：

| 工具 | 打到 |
|---|---|
| `wallpaper_status` | GET `/status` |
| `wallpaper_list` | GET `/inventory` |
| `wallpaper_use` | POST `/settings` `{id}` |
| `wallpaper_get` | GET `/settings` |
| `wallpaper_set` | POST `/settings` `{patch}` |
| `wallpaper_panel` | POST `/panel-open` |
| `wallpaper_upload` | POST `/upload` + POST `/settings` `{id}` |
| `wallpaper_remove` | POST `/remove` |
| `wallpaper_apply` | POST `/apply` |
| `wallpaper_mascot` | GET/HEAD/POST/DELETE `/mascot` |
| `wallpaper_avatar` | GET/HEAD/POST/DELETE `/avatar/<side>` |
| `wallpaper_fontset` | GET `/fontsets/list`、GET `/fontsets/get/<id>`、DELETE `/fontsets/delete/<id>`、POST `/settings` `{fontSetId}` |
| `wallpaper_system_fonts` | GET `/system-fonts` |
| `wallpaper_rotation` | GET/POST `/settings`（`rotationGroups` / `rotationGroupId` / `rotationEnabled`） |
| `wallpaper_preset` | 全族 `/presets*` |
| `wallpaper_launch_codex` | 不走 HTTP（`spawn` ChatGPT 带调试端口） |

## CLI 专属能力（不走 HTTP，因此不在上表）

`cwe autostart on|off|status` 是纯本地动作，宿主不需要在场：

| 子命令 | 落到磁盘/系统的什么 | 说明 |
|---|---|---|
| `autostart on` | 写 `~/Library/LaunchAgents/com.codexwallpaper.engine.watch.plist` | `RunAtLoad` + `KeepAlive` + `ThrottleInterval 10` + `ProcessType Background`；stdout/stderr 都指向 `watch.launchd.log`。随后 `launchctl load`，并 detach 一个宿主守护 |
| `autostart off` | 先 `launchctl list` 查有没有加载，加载过才 `unload -w`，再删 plist | 没加载时直接删，不调用 unload —— 否则 launchd 会往 stderr 吐 `Unload failed: 5: Input/output error` |
| `autostart status` | 读 plist 是否存在 + `launchctl list` 是否含该 label + 看门人进程在不在 | 三行分别报，不合并成一个是/否 |

看门人 `bin/cwe-watch.mjs` 的逻辑：轮询 Codex 进程，发现新起的实例没带 `--remote-debugging-port`，就用同一份二进制带端口重启一次。它不碰 HTTP，也不改配置。

## 权限与失败语义

- 未知 token → 404 `unknown token`
- 越界路径 → 403 `forbidden`
- 体超限 → 413；非法 JSON → 400；未知动作 → 405 或 404
- 任何 handler 抛错都被 `try/catch` 收成 500 `internal error`，同时进 `stats.errors` 内存环和 `cwe.log`

/**
 * src/host/inventory.mjs —— 壁纸清单（只扫用户自上传目录）
 *
 * 这一版刻意只有一条数据源：<uploadDir> 里的图片与视频。
 * 早先还接过 Steam / Wallpaper Engine 工程扫描（video / web / scene / image 四类），
 * 但那个方向要求本机装着 Wallpaper Engine 且能定位到它的库目录，随包带来的
 * vendor 解析器（pkg/tex 头、scene 内嵌 mp4 抽取）全部只为一个已删除的功能服务。
 * 现在清单 = 用户在面板里拖进来的东西，加上他们自己指定的上传目录。
 *
 * 只有一层缓存：内存 TTL 5s。
 * 原来那套「落盘索引 + 签名 + stale-while-revalidate」是为遍历 Steam 库设计的
 * （那要 stat 上千个目录）；readdir 一个上传目录是毫秒级，落盘索引反而多一次 IO。
 *
 * 三条不变量（照旧，别破坏）：
 *   · 对外 URL 一律带 token，清单里绝不出现真实路径
 *   · 上传条目 playable 恒 true（portableCount 靠它统计）
 *   · 读盘失败不许让整份清单 500 —— 回空列表 + 记日志
 */

import { join } from "node:path";
import { DIRS } from "./data-dir.mjs";
import { extOf, naturalCompare } from "./fs-paths.mjs";
import { enumerateUploads, metaEntry, readUploadMeta, getUploadDir } from "./uploads.mjs";

const INVENTORY_TTL_MS = 5_000;

const VIDEO_EXT_RE = /^(mp4|webm)$/i;

export function createInventory({ log = () => {}, tokenFor } = {}) {
  let mem = null;        // { at, payload }
  let inflight = null;   // Promise

  const stats = { builds: 0, cacheHits: 0, lastBuildMs: 0, lastError: null, total: 0 };

  // ---------- URL 铸造 ----------
  function mediaUrl(abs, kind = "media") {
    return "/wallpaper-engine/" + kind + "/" + tokenFor(abs, kind);
  }

  function previewUrl(abs) {
    if (!abs) return null;
    return "/wallpaper-engine/preview/" + tokenFor(abs, "preview");
  }

  // ---------- 条目 ----------
  function rowFor(f, metaEntryFor) {
    const type = VIDEO_EXT_RE.test(f.ext) ? "video" : "image";
    const row = {
      id: f.id,
      title: metaEntryFor.title || f.id,
      type,
      contentrating: metaEntryFor.contentrating || null,
      schemeColor: null,
      source: "upload",
      media: mediaUrl(f.file, "media"),
      preview: previewUrl(f.file),
      frameUrl: null,
      propsUrl: null,
      hidden: false,
      // 上传条目一定有文件，playable 恒 true
      playable: true,
    };
    if (type === "video") row.mime = f.ext === ".webm" ? "video/webm" : "video/mp4";
    return row;
  }

  async function scan() {
    const t0 = Date.now();
    const uploadDir = getUploadDir();
    const wallpapers = [];
    try {
      const meta = readUploadMeta();
      for (const f of enumerateUploads(uploadDir)) {
        wallpapers.push(rowFor(f, metaEntry(meta, f.id)));
      }
    } catch (err) {
      // 上传目录没挂载 / 权限不对：回空清单，但要把原因留在 stats 里
      stats.lastError = String((err && err.message) || err);
      log("warn", "inventory scan failed: " + stats.lastError);
    }
    wallpapers.sort((a, b) => naturalCompare(a.title || "", b.title || ""));

    const counts = {};
    for (const w of wallpapers) counts[w.type] = (counts[w.type] || 0) + 1;

    const payload = {
      version: 3,
      uploadDir,
      cacheDir: DIRS.cache,
      total: wallpapers.length,
      portableCount: wallpapers.filter((w) => w.playable).length,
      counts,
      wallpapers,
    };
    stats.builds++;
    stats.total = wallpapers.length;
    stats.lastBuildMs = Date.now() - t0;
    return payload;
  }

  function refresh() {
    if (inflight) return inflight;
    inflight = scan().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    async build() {
      const now = Date.now();
      if (mem && now - mem.at < INVENTORY_TTL_MS) {
        stats.cacheHits++;
        return mem.payload;
      }
      try {
        const payload = await refresh();
        mem = { at: Date.now(), payload };
        return payload;
      } catch (err) {
        stats.lastError = String((err && err.message) || err);
        log("error", "inventory build failed: " + stats.lastError);
        if (mem) return mem.payload;
        throw err;
      }
    },
    invalidate() { mem = null; },
    stats,
  };
}

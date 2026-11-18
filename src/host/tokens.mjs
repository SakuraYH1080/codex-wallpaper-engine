/**
 * 媒体 token 表：把「绝对路径」换成不可猜的短 token。
 *
 * 为什么需要：注入层拿到的清单里不能出现真实文件路径（本地路径泄露 + 页面里任何人都能
 * 直接拼 http://127.0.0.1:PORT/ 读任意文件）。token 只是内存里的一张 Map，进程重启即失效，
 * 因此清单缓存的形态必须排除 token（见 inventory.mjs 的缓存纪律）。
 */
import { createHash, randomBytes } from "node:crypto";

export function createTokenStore() {
  /** token -> { abs, kind, mtime, extra } */
  const map = new Map();
  /** "kind:abs" -> token（同一条媒体复用同一 token，清单不会每次都长新串） */
  const reverse = new Map();

  function tokenFor(abs, kind = "media", extra = null) {
    const key = kind + ":" + abs;
    const hit = reverse.get(key);
    if (hit) {
      const e = map.get(hit);
      if (e) { e.extra = extra; return hit; }
    }
    const t = createHash("sha1").update(key).digest("hex").slice(0, 12) + randomBytes(3).toString("hex");
    map.set(t, { abs, kind, extra, at: Date.now() });
    reverse.set(key, t);
    return t;
  }

  function get(token) {
    return map.get(token) || null;
  }

  function drop(token) {
    const e = map.get(token);
    if (!e) return;
    map.delete(token);
    reverse.delete(e.kind + ":" + e.abs);
  }

  /** 清掉不在 keep 集合里的 token（重扫收尾用，防止 Map 无界增长）。 */
  function prune(keepTokens) {
    for (const [t, e] of map) if (!keepTokens.has(t)) drop(t);
  }

  function size() { return map.size; }

  return { tokenFor, get, drop, prune, size };
}

/**
 * src/host/port-pick.mjs —— 给 CDP 挑一个真能用的端口
 *
 * 为什么要挑：Codex 是用 --remote-debugging-port=P 启动的。P 上要是已经有别的
 * 程序在听，Codex 那个监听就绑不上，CDP 永远起不来，注入器只能干等 ——
 * 表现是「插件明明装了却没反应」，日志里什么都没有。
 *
 * 三种状态要分开，不能一律当「空闲」：
 *   cdp   端口上已经有一个 DevTools 端点（多半就是上次留着的 Codex）→ 直接复用
 *   free  端口没人听 → 可以用它去启动
 *   busy  端口被非 DevTools 的程序占着 → 跳过，换下一个
 *
 * 原来 server.mjs 的 listen() 是 EADDRINUSE 后 +1 连试 12 次，那是在同一个
 * 进程里撞自己的端口，和这里的「给别的进程挑端口」是两件事，不能互相替代。
 */

import { connect } from "node:net";
import { probePort } from "./cdp.mjs";

const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** 端口号合法化：越界或非数字都退回 fallback。 */
export function clampPort(p, fallback = 9333) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) return fallback;
  return n;
}

/**
 * 端口上有没有人在听。
 * 只看「能不能连上」——连不上（ECONNREFUSED / 超时）就算空闲。
 */
export function portListening(port, host = "127.0.0.1", timeoutMs = 350) {
  return new Promise((resolveP) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolveP(v);
    };
    const sock = connect({ port, host });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(true)); // 半开状态也当占用，不去抢
    sock.once("error", (err) => {
      // ECONNREFUSED 是「没人听」，其他错误保守当成占用
      done(!(err && err.code === "ECONNREFUSED"));
    });
  });
}

/**
 * 挑一个端口。
 * 顺序有讲究：先把 preferred..preferred+span 全扫一遍找已存在的 CDP
 * （重启守护时最常见的期望是「还连着我上次那个」），
 * 全都没有才按同样的顺序找第一个真正空闲的。
 *
 * 返回 { port, state, info }，永不 reject —— 挑不到就把 preferred 交回去，
 * 让上层照旧试，失败也有日志可看。
 */
export async function pickCdpPort(preferred = 9333, { span = 12, host = "127.0.0.1" } = {}) {
  const start = clampPort(preferred);
  const candidates = [];
  for (let i = 0; i < span; i++) {
    const p = start + i;
    if (p <= MAX_PORT) candidates.push(p);
  }

  for (const p of candidates) {
    const info = await probePort(p);
    if (info) return { port: p, state: "cdp", info };
  }

  for (const p of candidates) {
    if (!(await portListening(p, host))) return { port: p, state: "free", info: null };
  }

  return { port: start, state: "busy", info: null };
}

/**
 * 给一段人能读的说明。CLI 和日志共用，避免两边措辞漂移。
 */
export function describePick(pick, preferred) {
  if (!pick) return "";
  if (pick.state === "cdp") return "复用已开的调试端口 " + pick.port;
  if (pick.state === "busy") return "候选端口全被占着，仍试 " + pick.port + "（配置里是 " + preferred + "）";
  if (pick.port !== preferred) return "配置端口 " + preferred + " 被占，改用 " + pick.port;
  return "调试端口 " + pick.port;
}

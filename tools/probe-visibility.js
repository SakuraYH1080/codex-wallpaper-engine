(() => {
  const out = {
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    w: innerWidth, h: innerHeight,
    audioCtxState: (() => { try { const c = new AudioContext(); const s = c.state; c.close(); return s; } catch (e) { return 'ERR ' + e.message; } })(),
    mediaCap: (() => {
      try {
        return typeof navigator.mediaCapabilities !== 'undefined' ? 'present' : 'absent';
      } catch (e) { return 'ERR'; }
    })(),
    uaData: navigator.userAgentData ? 'present' : 'absent',
  };
  // 用 AudioContext 播放一个短 tone 看看 audio 通路是否活着（顺便测 media 时钟）
  return out;
})()
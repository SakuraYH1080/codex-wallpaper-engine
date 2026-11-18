(() => {
  const v = document.querySelector('#cwe-root video');
  const out = {
    vis: document.visibilityState,
    hidden: document.hidden,
    focus: document.hasFocus(),
  };
  if (!v) { out.video = null; return out; }
  out.video = {
    src: (v.currentSrc || v.src || '').slice(0, 90),
    readyState: v.readyState,
    networkState: v.networkState,
    paused: v.paused,
    loop: v.loop,
    muted: v.muted,
    volume: v.volume,
    rate: v.playbackRate,
    duration: v.duration,
    videoW: v.videoWidth,
    videoH: v.videoHeight,
    currentTime: v.currentTime,
    err: v.error ? (v.error.code + ':' + v.error.message) : null,
  };
  return out;
})()
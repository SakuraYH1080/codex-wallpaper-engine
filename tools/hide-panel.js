(async () => {
  try { window.__CWE && window.__CWE.panel && window.__CWE.panel.hide(); } catch {}
  // 强制一次重排 + 等两帧，确保合成器刷新（否则 captureScreenshot 会拿到旧帧）
  document.documentElement.style.setProperty('--cwe-nudge', String(Date.now()));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise(r => setTimeout(r, 900));
  const v = document.querySelector('#cwe-root video');
  return {
    panelOpen: !!(document.getElementById('cwe-panel-host') && document.getElementById('cwe-panel-host').shadowRoot &&
      document.getElementById('cwe-panel-host').shadowRoot.querySelector('.wrap[data-open=\"1\"]')),
    t: v ? Math.round(v.currentTime * 100) / 100 : null,
    rs: v ? v.readyState : null,
  };
})()
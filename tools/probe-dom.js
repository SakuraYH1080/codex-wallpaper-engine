(() => {
  const root = document.getElementById('cwe-root');
  const slots = root ? [...root.querySelectorAll('.cwe-slot')] : [];
  return {
    bodyFirst: document.body.firstChild && (document.body.firstChild.id || document.body.firstChild.tagName),
    rootDisplay: root ? getComputedStyle(root).display : null,
    rootOpacity: root ? getComputedStyle(root).opacity : null,
    rootTransform: root ? getComputedStyle(root).transform : null,
    slots: slots.map(s => ({
      opacity: getComputedStyle(s).opacity,
      bg: (s.style.backgroundImage || '').slice(0, 48),
      kids: [...s.children].map(k => k.tagName + (k.src ? ' ' + String(k.src).slice(0, 40) : '')),
    })),
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    surfaces: [...document.querySelectorAll('main,div[class*=PageSurfaceLayout],webview,aside')].slice(0, 10)
      .map(e => e.tagName + '.' + String(e.className).slice(0, 26) + ' = ' + getComputedStyle(e).backgroundColor),
    fxCanvas: !!document.getElementById('cwe-fx'),
    mascot: !!document.getElementById('cwe-mascot'),
    styleLen: (document.getElementById('cwe-style') || {}).textContent ? document.getElementById('cwe-style').textContent.length : 0,
  };
})()
(() => {
  const d = document;
  const m = d.getElementById('cwe-mascot');
  const rope = d.getElementById('cwe-rope');
  const img = m ? m.querySelector('img') : null;
  const r = m ? m.getBoundingClientRect() : null;
  const rs = rope ? rope.getBoundingClientRect() : null;
  const cs = m ? getComputedStyle(m) : null;
  // 字体：抓几条实际生效的字号
  const scope = d.querySelector("#root main[class*='MainContentSurface']") || d.querySelector('#root');
  const sizes = {};
  if (scope) {
    ['h1','h2','h3','small','td'].forEach(t => {
      const el = scope.querySelector(t);
      if (el) sizes[t] = getComputedStyle(el).fontSize;
    });
  }
  const bodyFont = getComputedStyle(d.body).fontFamily;
  return {
    mascot: !!m,
    mascotRect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    mascotBg: cs ? cs.backgroundImage.slice(0, 60) : null,
    mascotOpacity: cs ? cs.opacity : null,
    mascotTransform: cs ? cs.transform : null,
    img: img ? { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight, fit: getComputedStyle(img).objectFit } : null,
    rope: !!rope,
    ropeRect: rs ? [Math.round(rs.x), Math.round(rs.y), Math.round(rs.width), Math.round(rs.height)] : null,
    ropePaths: rope ? rope.querySelectorAll('path').length : 0,
    ropeStroke: rope && rope.querySelector('path') ? rope.querySelector('path').getAttribute('stroke') : null,
    fontSizes: sizes,
    bodyFont: bodyFont,
    styleLen: (d.getElementById('cwe-style') || {}).textContent ? d.getElementById('cwe-style').textContent.length : 0,
    hasFontCss: (d.getElementById('cwe-style') || {}).textContent ? d.getElementById('cwe-style').textContent.includes('/* cwe font */') : false,
  };
})()
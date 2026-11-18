(() => {
  const out = [];
  const walk = (el, d) => {
    if (d > 6) return;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 30) { /* still descend */ }
    const cs = getComputedStyle(el);
    if (r.width > 60 && r.height > 30 && d < 7) {
      out.push({
        d,
        tag: el.tagName,
        cls: (el.className && String(el.className).slice(0, 90)) || "",
        id: el.id || "",
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        bg: cs.backgroundColor,
        bf: (cs.backdropFilter || "").slice(0, 20),
        pos: cs.position,
      });
    }
    for (const c of el.children) walk(c, d + 1);
  };
  walk(document.body, 0);
  return out.slice(0, 120);
})()
(async () => {
  const C = window.__CWE;
  if (C && C.panel) C.panel.hide();
  await new Promise(r => setTimeout(r, 400));
  const base = C.state.base;
  let fetchOk = null, inv = null;
  try {
    const r = await fetch(base + '/wallpaper-engine/inventory');
    fetchOk = r.status;
    const j = await r.json();
    inv = { total: j.total, count: (j.wallpapers||[]).length };
  } catch (e) { fetchOk = 'ERR:' + e.message; }
  return { base, fetchOk, inv, panelOpen: C.panel ? undefined : null };
})()
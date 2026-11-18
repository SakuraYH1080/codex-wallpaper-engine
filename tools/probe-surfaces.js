(() => {
  const hit = (sel) => {
    const el = document.querySelectorAll(sel);
    return el.length;
  };
  const klass = (needle) => {
    const out = new Set();
    document.querySelectorAll("[class]").forEach((e) => {
      const c = e.getAttribute("class") || "";
      if (c.toLowerCase().includes(needle)) out.add(c.split(/\s+/).filter(x => x.toLowerCase().includes(needle)).join(" "));
    });
    return [...out].slice(0, 6);
  };
  return {
    asideAll: [...document.querySelectorAll("aside")].map(a => (a.className||"").slice(0, 60)),
    rightPanel: klass("right"),
    sidebar: klass("sidebar"),
    thinking: klass("thinking"),
    reasoning: klass("reasoning"),
    buttons: [...document.querySelectorAll("button")].length,
    links: klass("link"),
    composer: klass("prose"),
    codeBlocks: document.querySelectorAll("pre").length,
    titlebar: klass("toolbar"),
  };
})()
// Runs inside the Business Suite page itself (not the extension sandbox), because only the page can read
// the search results' data. It only does what a person does: types a name in the inbox search box,
// reads the "People" results, then clears the box again. It never clicks a chat and never sends anything.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isPic = (s) => /^https:\/\/[^/]*(fbcdn\.net|scontent)/.test(s || "");
  function searchBox() {
    return [...document.querySelectorAll("input")].find((i) => /search/i.test(i.placeholder || i.getAttribute("aria-label") || "") && i.getBoundingClientRect().left < window.innerWidth * 0.45);
  }
  function setValue(inp, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(inp, v);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function entryOf(el) {
    const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    let f = fk && el[fk];
    for (let d = 0; f && d < 12; d++, f = f.return) {
      const e = f.memoizedProps && f.memoizedProps.entry;
      if (e && typeof e === "object" && e.messengerThreadID !== undefined) return e;
    }
    return null;
  }
  function read(name) {
    const want = name.trim().toLowerCase();
    const seen = new Map();
    document.querySelectorAll("img").forEach((img) => {
      if (!isPic(img.src) || img.getBoundingClientRect().left > window.innerWidth * 0.45) return;
      let el = img;
      for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
        const e = entryOf(el);
        if (!e) continue;
        const uid = String(e.messengerThreadID || "");
        if (!/^\d{6,20}$/.test(uid)) break;
        const vals = Object.keys(e).map((k) => e[k]).filter((v) => typeof v === "string");
        const nm = vals.find((v) => v.trim().toLowerCase() === want) || "";
        const pic = vals.find(isPic) || img.currentSrc || img.src;
        const username = vals.find((v) => /^[a-z0-9.]{5,50}$/i.test(v) && !/^\d+$/.test(v) && v.toLowerCase() !== want) || "";
        if (nm) seen.set(uid, { uid, name: nm, username, pic });
        break;
      }
    });
    return [...seen.values()];
  }
  let busy = false;
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.sk !== "find" || busy) return;
    busy = true;
    let list = [];
    try {
      const inp = searchBox();
      if (inp) {
        const before = inp.value;
        setValue(inp, d.name);
        for (let i = 0; i < 20 && !list.length; i++) { await sleep(300); list = read(d.name); }
        await sleep(400);
        list = read(d.name);
        setValue(inp, before);
      }
    } catch (e) { /* report nothing found */ }
    busy = false;
    window.postMessage({ sk: "found", rid: d.rid, list }, "*");
  });
})();

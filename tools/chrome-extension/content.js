// Reads avatars that are already visible in the Business Suite inbox.
// Catch-up: if recent customers still have no picture, it slowly scrolls ONLY the chat list
// (no clicks, no typing, no messages) until they appear, then scrolls back to the top.
(function () {
  const sent = new Set();
  const seenNames = new Set();
  const isCdn = (s) => /^https:\/\/[^/]*(fbcdn\.net|scontent)[^/]*\//.test(s || "");
  const bad = /^(\d{1,2}:\d{2}\s?(AM|PM)?|Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d+[mhdw])$/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function nameFor(img) {
    if (img.alt && img.alt.trim().length > 1) return img.alt.trim();
    let el = img;
    for (let i = 0; i < 9 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const line = (el.innerText || "").trim().split("\n")[0].trim();
      if (line && !bad.test(line) && line.length <= 80) return line;
    }
    return "";
  }
  function pageId() {
    try { return new URL(location.href).searchParams.get("asset_id") || ""; } catch (e) { return ""; }
  }
  function rowOf(img) {
    return img.closest("[data-maiba-contact-id]");
  }
  function previewFor(img) {
    let el = img;
    for (let i = 0; i < 9 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const lines = (el.innerText || "").trim().split("\n").map((x) => x.trim()).filter(Boolean);
      if (lines.length >= 2 && !bad.test(lines[0])) return lines.slice(1).find((l) => !bad.test(l)) || "";
    }
    return "";
  }
  function avatars() {
    return [...document.querySelectorAll("img")].filter((img) => img.width >= 24 && img.width <= 72 && isCdn(img.src));
  }
  function scan() {
    const out = [];
    avatars().forEach((img) => {
      if (!img.complete) return;
      const name = nameFor(img);
      if (!name) return;
      seenNames.add(name);
      const row = rowOf(img);
      const fb = row ? row.getAttribute("data-maiba-contact-id") : "";
      const key = name + "|" + (fb || "");
      if (sent.has(key)) return;
      sent.add(key);
      out.push({ name, src: img.currentSrc || img.src, page_id: pageId(), fb_uid: fb || "", preview: previewFor(img).slice(0, 80) });
    });
    if (out.length) chrome.runtime.sendMessage({ type: "avatars", items: out });
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(scan, 1200); };
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true });
  kick();

  // ── catch-up ──
  let userBusy = 0;
  ["wheel", "mousedown", "keydown", "touchstart"].forEach((ev) => window.addEventListener(ev, (e) => { if (e.isTrusted) userBusy = Date.now(); }, true));

  function listBox() {
    // the scrollable element that holds the conversation avatars on the left
    const imgs = avatars().filter((i) => i.getBoundingClientRect().left < window.innerWidth * 0.4);
    for (const img of imgs) {
      let el = img.parentElement;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 50) return el;
        el = el.parentElement;
      }
    }
    return null;
  }
  function ask(msg) { return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {}))); }

  async function catchUp() {
    const last = (await chrome.storage.local.get("catchup_at")).catchup_at || 0;
    if (Date.now() - last < 30 * 60 * 1000) return; // at most every 30 minutes per browser
    const r = await ask({ type: "missing", page_id: pageId() });
    let need = (r.names || []).filter((n) => !seenNames.has(n));
    if (!need.length) return;
    await chrome.storage.local.set({ catchup_at: Date.now() });
    const box = listBox();
    if (!box) return;
    let steps = 0, stuck = 0, prevH = 0;
    while (need.length && steps < 60) {
      if (document.visibilityState !== "visible") { await sleep(3000); continue; }
      if (Date.now() - userBusy < 15000) return; // the person is using the inbox: stop and leave the list where they put it
      const before = box.scrollTop;
      box.scrollBy({ top: Math.round(box.clientHeight * (0.6 + Math.random() * 0.2)), behavior: "smooth" });
      steps++;
      await sleep(2500 + Math.random() * 2000);
      scan();
      need = need.filter((n) => !seenNames.has(n));
      if (box.scrollTop === before && box.scrollHeight === prevH) { if (++stuck >= 3) break; } else stuck = 0;
      prevH = box.scrollHeight;
    }
    await sleep(1500);
    if (Date.now() - userBusy > 15000) box.scrollTo({ top: 0, behavior: "smooth" });
  }
  setTimeout(() => { catchUp().catch(() => {}); }, 10000);
  setInterval(() => { catchUp().catch(() => {}); }, 31 * 60 * 1000);
})();

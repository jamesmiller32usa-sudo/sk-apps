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
  // Retry: forget what was already sent every 3 minutes and look again. Customers already saved are
  // skipped by the background cache, so only the ones that failed (for example a brand new chat that
  // was not in the database yet) are tried again.
  setInterval(() => { sent.clear(); scan(); }, 3 * 60 * 1000);
  // Keep the page fresh: reload Business Suite every 2 hours, but only when nobody has used it for 10 minutes.
  const bornAt = Date.now();
  setInterval(() => { if (Date.now() - bornAt > 2 * 3600e3 && Date.now() - userBusy > 10 * 60 * 1000) location.reload(); }, 5 * 60 * 1000);
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true });
  kick();


  // ── "Get photo" button in the CRM ──
  // Every 3 seconds ask whether someone pressed "Get photo" for a customer of this page. If so, look the
  // name up with the inbox search (works however far down the chat is) and send the result to the server.
  function findInPage(name, rid) {
    return new Promise((res) => {
      const done = (ev) => { const d = ev.data; if (ev.source === window && d && d.sk === "found" && d.rid === rid) { window.removeEventListener("message", done); res(d.list || []); } };
      window.addEventListener("message", done);
      window.postMessage({ sk: "find", name, rid }, "*");
      setTimeout(() => { window.removeEventListener("message", done); res([]); }, 9000);
    });
  }
  // Who with this exact name is visible in the chat list right now (Facebook id comes from the row itself).
  function rowsNamed(name) {
    const want = name.trim().toLowerCase(), out = new Map();
    document.querySelectorAll("[data-maiba-contact-id]").forEach((row) => {
      const first = ((row.innerText || "").trim().split("\n")[0] || "").trim().toLowerCase();
      const img = row.querySelector("img");
      const uid = row.getAttribute("data-maiba-contact-id");
      if (first === want && img && isCdn(img.src) && /^\d{6,20}$/.test(uid || "")) out.set(uid, { uid, pic: img.currentSrc || img.src, username: "" });
    });
    return [...out.values()];
  }
  async function handleRequest(q) {
    // 1. already on screen: instant
    let list = rowsNamed(q.name);
    if (list.length) return list;
    // 2. inbox search: works however far down the chat is, if only one person has this name
    const found = await findInPage(q.name, q.id);
    if (found.length === 1) return found;
    // 3. common name: walk down the chat list until the row appears
    const box = listBox();
    if (!box) return found;
    const start = box.scrollTop;
    let stuck = 0, prevH = 0;
    for (let i = 0; i < 150 && !list.length; i++) {
      const before = box.scrollTop;
      box.scrollBy({ top: Math.round(box.clientHeight * 0.85) });
      await sleep(1100);
      list = rowsNamed(q.name);
      if (box.scrollTop === before && box.scrollHeight === prevH) { if (++stuck >= 8) break; box.scrollBy({ top: -150 }); await sleep(600); } else stuck = 0;
      prevH = box.scrollHeight;
    }
    box.scrollTo({ top: start });
    return list.length ? list : found;
  }
  let reqBusy = false;
  setInterval(async () => {
    if (reqBusy || !pageId()) return;
    reqBusy = true;
    try {
      const r = await ask({ type: "requests", page_id: pageId() });
      for (const q of r.items || []) {
        const list = await handleRequest(q);
        await ask({ type: "resolve", request: q, list });
      }
    } catch (e) {}
    reqBusy = false;
  }, 3000);

  // ── catch-up ──
  let userBusy = 0;
  let robot = false; // set by the background script; true only on the 24/7 server browser
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
    const ck = "catchup_at_" + pageId(); // each page keeps its own timer, so all three tabs catch up
    const last = (await chrome.storage.local.get(ck))[ck] || 0;
    if (Date.now() - last < (robot ? 10 : 15) * 60 * 1000) return; // humans: every 30 min; robot: every 10 min per page
    const r = await ask({ type: "missing", page_id: pageId() });
    let need = (r.names || []).filter((n) => !seenNames.has(n));
    if (!need.length) return;
    await chrome.storage.local.set({ [ck]: Date.now() });
    const box = listBox();
    if (!box) return;
    let steps = 0, stuck = 0, prevH = 0;
    while (need.length && steps < 150) {
      if (document.visibilityState !== "visible") { await sleep(3000); continue; }
      if (!robot && Date.now() - userBusy < 15000) return; // the person is using the inbox: stop and leave the list where they put it
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
  // robot only: once a day scroll the whole list to the bottom so every old customer is collected
  async function fullSweep() {
    const k = "sweep_" + pageId();
    const last = (await chrome.storage.local.get(k))[k] || 0;
    if (Date.now() - last < 24 * 3600e3) return;
    const box = listBox(); if (!box) return;
    let stuck = 0, prevH = 0, steps = 0;
    while (stuck < 40 && steps < 3000) {
      const before = box.scrollTop;
      box.scrollBy({ top: Math.round(box.clientHeight * 0.7), behavior: "smooth" });
      steps++;
      await sleep(2500 + Math.random() * 1500);
      scan();
      if (box.scrollTop === before && box.scrollHeight === prevH) { stuck++; box.scrollBy({ top: -200 }); await sleep(800); } else stuck = 0;
      prevH = box.scrollHeight;
    }
    await chrome.storage.local.set({ [k]: Date.now() });
    box.scrollTo({ top: 0, behavior: "smooth" });
  }
  ask({ type: "robot" }).then((r) => {
    robot = !!r.robot;
    if (robot) {
      setInterval(scan, 5000); // new chats jump to the top of the list; pick them up within seconds
      setTimeout(() => { fullSweep().catch(() => {}).then(() => catchUp().catch(() => {})); }, 20000);
      setInterval(() => { catchUp().catch(() => {}); }, 11 * 60 * 1000);
    } else {
      setTimeout(() => { catchUp().catch(() => {}); }, 10000);
      setInterval(() => { catchUp().catch(() => {}); }, 16 * 60 * 1000);
    }
  });
})();

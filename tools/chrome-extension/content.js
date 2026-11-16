// Reads avatars that are already visible in the Business Suite inbox. No clicks, no typing, no requests to Meta.
(function () {
  const sent = new Set();
  const isCdn = (s) => /^https:\/\/[^/]*(fbcdn\.net|scontent)[^/]*\//.test(s || "");
  const bad = /^(\d{1,2}:\d{2}\s?(AM|PM)?|Yesterday|Today|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d+[mhdw])$/i;

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
  function scan() {
    const out = [];
    document.querySelectorAll("img").forEach((img) => {
      const w = img.width;
      if (w < 24 || w > 72 || !isCdn(img.src) || !img.complete) return;
      const name = nameFor(img);
      if (!name || sent.has(name)) return;
      sent.add(name);
      out.push({ name, src: img.currentSrc || img.src, page_id: pageId() });
    });
    if (out.length) chrome.runtime.sendMessage({ type: "avatars", items: out });
  }
  let t = null;
  const kick = () => { clearTimeout(t); t = setTimeout(scan, 1500); };
  new MutationObserver(kick).observe(document.body, { childList: true, subtree: true });
  kick();
})();

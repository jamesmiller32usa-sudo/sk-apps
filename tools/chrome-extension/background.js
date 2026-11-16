// Queue: one picture at a time, a short pause between each, so the browser never slows down.
const SUPA = "https://dkwlsfzysjdubcwuemvx.supabase.co/functions/v1/inbox-avatar";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrd2xzZnp5c2pkdWJjd3VlbXZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5OTgxNzQsImV4cCI6MjA5MzU3NDE3NH0.SAf7NDNbtrOFW8JDM_WDJ8Dbz_bCdzMJDV6RLp_pCUA";
const queue = [];
let busy = false;

async function done(name) {
  const k = "d2:" + name;
  const r = await chrome.storage.local.get(k);
  return r[k] && Date.now() - r[k] < 7 * 864e5;
}
async function mark(name) { await chrome.storage.local.set({ ["d2:" + name]: Date.now() }); }
async function call(body) {
  const r = await fetch(SUPA, { method: "POST", headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY }, body: JSON.stringify(body) });
  return r.json();
}
function toB64(buf) {
  let s = ""; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function work() {
  if (busy) return; busy = true;
  while (queue.length) {
    const it = queue.shift();
    const key = it.name + "|" + (it.fb_uid || "");
    try {
      if (await done(key)) continue;
      const base = { name: it.name, page_id: it.page_id, fb_uid: it.fb_uid || null, preview: it.preview || "" };
      const chk = await call({ ...base, check: true });
      if (!chk.need) { if (chk.reason !== "unknown") await mark(key); continue; }
      const body = { ...base };
      if (chk.needImage) {
        const res = await fetch(it.src);
        if (!res.ok) continue;
        body.type = res.headers.get("content-type") || "image/jpeg";
        body.image = toB64(await res.arrayBuffer());
      }
      const out = await call(body);
      if (out.status === "saved" || out.status === "exists" || out.status === "ambiguous") await mark(key);
    } catch (e) { /* try again next time it is on screen */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  busy = false;
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "missing") {
    call({ missing: true, page_id: msg.page_id || null }).then(reply).catch(() => reply({ names: [] }));
    return true;
  }
  if (msg && msg.type === "avatars") { for (const it of msg.items) if (!queue.some((q) => q.name === it.name && q.fb_uid === it.fb_uid)) queue.push(it); work(); }
});

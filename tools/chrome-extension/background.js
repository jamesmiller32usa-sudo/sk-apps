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
      if (!chk.need) { if (!chk.reason) await mark(key); continue; } // unknown or ambiguous: try again later
      const body = { ...base };
      if (chk.needImage) {
        const res = await fetch(it.src);
        if (!res.ok) continue;
        body.type = res.headers.get("content-type") || "image/jpeg";
        body.image = toB64(await res.arrayBuffer());
      }
      const out = await call(body);
      if (out.status === "saved" || out.status === "exists") await mark(key);
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

// ── robot mode (24/7 server browser only) ──
// Turned on only when the folder contains robot.json. A normal moderator install has no robot.json,
// so none of this runs there. In robot mode the extension keeps one visible window per page open
// and reloads each one every 3 hours so the inbox list stays fresh.
const PAGES = ["378409686340444", "418805531314590", "118478659947199"];
const inbox = (id) => "https://business.facebook.com/latest/inbox/all/?asset_id=" + id;
let robotFlag = null;
async function isRobot() {
  if (robotFlag !== null) return robotFlag;
  try { const r = await fetch(chrome.runtime.getURL("robot.json")); robotFlag = r.ok; } catch (e) { robotFlag = false; }
  return robotFlag;
}
async function keepWindows() {
  if (!(await isRobot())) return;
  const st = (await chrome.storage.local.get("robot_tabs")).robot_tabs || {};
  for (let i = 0; i < PAGES.length; i++) {
    const id = PAGES[i];
    let alive = false;
    if (st[id]) { try { await chrome.tabs.get(st[id].tab); alive = true; } catch (e) {} }
    if (!alive) {
      const w = await chrome.windows.create({ url: inbox(id), left: i * 640, top: 0, width: 640, height: 1000, focused: false, state: "normal" });
      st[id] = { tab: w.tabs[0].id, at: Date.now() };
    } else if (Date.now() - st[id].at > 3 * 3600e3) {
      await chrome.tabs.update(st[id].tab, { url: inbox(id) });
      st[id].at = Date.now();
    }
  }
  await chrome.storage.local.set({ robot_tabs: st });
}
chrome.runtime.onStartup.addListener(() => { setTimeout(keepWindows, 5000); });
chrome.runtime.onInstalled.addListener(() => { setTimeout(keepWindows, 5000); });
chrome.alarms.create("robot", { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "robot") keepWindows(); });
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "robot") { isRobot().then((r) => reply({ robot: r })); return true; }
});

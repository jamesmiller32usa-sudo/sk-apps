// Omnichannel Inbox - save a customer's profile picture and Facebook profile id sent by the
// "SK Inbox Pictures" Chrome extension. The extension only reads what Business Suite already shows on screen.
// Body: { name, page_id?, fb_uid?, preview?, image? (base64), type?, check?, missing? }
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ours = (r: any) => r.profile_pic && String(r.profile_pic).includes("/inbox-media/avatars/");
const norm = (t: string) => String(t || "").replace(/^You:\s*/i, "").replace(/[…\s]+$/g, "").replace(/\s+/g, " ").trim().toLowerCase();

function b64ToBytes(b64: string) {
  const bin = atob(b64.replace(/^data:[^,]+,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body = await req.json().catch(() => ({}));

  if (body.missing) {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    let q = sb.from("ib_conv_view").select("name, page_id, profile_pic, fb_uid").gte("last_message_at", since).not("name", "is", null)
      .order("last_message_at", { ascending: false }).limit(400);
    if (body.page_id) q = q.eq("page_id", String(body.page_id));
    const { data } = await q;
    const names = (data || []).filter((r: any) => !ours(r) || !r.fb_uid).map((r: any) => r.name);
    return json({ names: [...new Set(names)].slice(0, 200) });
  }

  const name = String(body.name || "").trim();
  const pageId = body.page_id ? String(body.page_id) : null;
  const fbUid = /^\d{6,20}$/.test(String(body.fb_uid || "")) ? String(body.fb_uid) : null;
  if (!name) return json({ error: "name required" }, 400);

  // Find the customer: same name (prefer the page Business Suite shows); break ties with the Facebook id or the last message.
  const find = async (pid: string | null) => {
    let q = sb.from("ib_contacts").select("id, page_id, profile_pic, fb_uid, ib_conversations(last_message_text, last_message_at)").eq("name", name);
    if (pid) q = q.eq("page_id", pid);
    const { data } = await q.limit(10);
    return data || [];
  };
  let list: any[] = await find(pageId);
  if (!list.length && pageId) list = await find(null);
  // A brand new chat shows in Business Suite at the same moment Meta sends us the webhook, so the
  // customer may not be in our database yet. Wait for it (up to about 25 seconds) instead of giving up.
  for (let i = 0; !list.length && i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    list = await find(pageId);
  }
  if (list.length > 1 && fbUid) {
    const same = list.filter((r) => r.fb_uid === fbUid);
    if (same.length === 1) list = same;
    // a customer who already has a different Facebook id is someone else
    else list = list.filter((r) => !r.fb_uid || r.fb_uid === fbUid);
  }
  if (list.length > 1 && body.preview) {
    const p = norm(body.preview);
    const hit = list.filter((r) => {
      const t = norm(r.ib_conversations?.[0]?.last_message_text || "");
      return p.length >= 4 && t && (t.startsWith(p.slice(0, 40)) || p.startsWith(t.slice(0, 40)));
    });
    if (hit.length === 1) list = hit;
    else if (p.length >= 6) {
      const k = p.slice(0, 14);
      const loose = list.filter((r) => norm(r.ib_conversations?.[0]?.last_message_text || "").includes(k));
      if (loose.length === 1) list = loose;
    }
  }
  if (list.length !== 1) return json(body.check ? { need: false, reason: list.length ? "ambiguous" : "unknown" } : { status: list.length ? "ambiguous" : "unknown" });
  const c = list[0];
  const needImage = !ours(c);
  const needUid = !!fbUid && !c.fb_uid;
  if (body.check) return json({ need: needImage || needUid, needImage });

  const patch: Record<string, unknown> = {};
  if (needUid) patch.fb_uid = fbUid;
  if (needImage || body.force) {
    if (body.image) {
      const bytes = b64ToBytes(String(body.image));
      if (bytes.length < 200 || bytes.length > 400000) return json({ error: "bad image size" }, 400);
      const type = /png|webp|jpeg|jpg|avif/.test(String(body.type)) ? String(body.type) : "image/jpeg";
      const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("avif") ? "avif" : "jpg";
      const path = `avatars/${c.id}.${ext}`;
      const up = await sb.storage.from("inbox-media").upload(path, bytes, { contentType: type, upsert: true, cacheControl: "604800" });
      if (up.error) return json({ error: up.error.message }, 500);
      patch.profile_pic = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/inbox-media/${path}?v=${Date.now()}`;
    }
  }
  if (Object.keys(patch).length) await sb.from("ib_contacts").update(patch).eq("id", c.id);
  return json({ status: Object.keys(patch).length ? "saved" : "exists" });
});

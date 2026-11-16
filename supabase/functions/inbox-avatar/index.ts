// Omnichannel Inbox - save a customer's profile picture sent by the "SK Inbox Pictures" Chrome extension.
// The extension only reads avatars that Business Suite already shows on screen; it never calls Meta.
// Body: { page_id?: string, name: string, image: base64 (jpeg/png/webp), type?: string }
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

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
  // Catch-up list: recent customers that still have no saved picture.
  if (body.missing) {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    let q = sb.from("ib_conv_view").select("name, page_id, profile_pic").gte("last_message_at", since).not("name", "is", null)
      .order("last_message_at", { ascending: false }).limit(400);
    if (body.page_id) q = q.eq("page_id", String(body.page_id));
    const { data } = await q;
    const names = (data || []).filter((r: any) => !(r.profile_pic && String(r.profile_pic).includes("/inbox-media/avatars/"))).map((r: any) => r.name);
    return json({ names: [...new Set(names)].slice(0, 200) });
  }
  const name = String(body.name || "").trim();
  const pageId = body.page_id ? String(body.page_id) : null;

  // 1. Which customers have this exact name? Prefer the page Business Suite is showing.
  const find = async (pid: string | null) => {
    let q = sb.from("ib_contacts").select("id, page_id, profile_pic").eq("name", name);
    if (pid) q = q.eq("page_id", pid);
    const { data } = await q.limit(5);
    return data || [];
  };
  let list = name ? await find(pageId) : [];
  if (!list.length && pageId) list = await find(null);
  const ours = (r: any) => r.profile_pic && String(r.profile_pic).includes("/inbox-media/avatars/");
  if (body.check) return json({ need: list.length === 1 && !ours(list[0]) });
  if (!name || !body.image) return json({ error: "name and image required" }, 400);
  if (list.length !== 1) return json({ status: list.length ? "ambiguous" : "unknown", matches: list.length });
  const c = list[0];
  if (ours(c) && !body.force) return json({ status: "exists" });

  const bytes = b64ToBytes(String(body.image));
  if (bytes.length < 200 || bytes.length > 400000) return json({ error: "bad image size" }, 400);
  const type = /png|webp|jpeg|jpg/.test(String(body.type)) ? String(body.type) : "image/jpeg";
  const path = `avatars/${c.id}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
  const up = await sb.storage.from("inbox-media").upload(path, bytes, { contentType: type, upsert: true, cacheControl: "604800" });
  if (up.error) return json({ error: up.error.message }, 500);
  const url = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/inbox-media/${path}?v=${Date.now()}`;
  await sb.from("ib_contacts").update({ profile_pic: url }).eq("id", c.id);
  return json({ status: "saved" });
});

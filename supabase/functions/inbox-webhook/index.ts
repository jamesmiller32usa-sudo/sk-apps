// Omnichannel Inbox - Meta webhook receiver
// Handles: Messenger (object=page), Instagram DM (object=instagram), FB comments (feed), IG comments.
// Secrets: META_VERIFY_TOKEN, META_APP_SECRET (optional but recommended), page tokens live in ib_page_tokens (service role only)
import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const tokenCache: Record<string, { t: string; at: number }> = {};
async function pageToken(pageId: string): Promise<string | undefined> {
  const c = tokenCache[pageId];
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.t;
  const { data } = await sb.from("ib_page_tokens").select("token").eq("page_id", pageId).maybeSingle();
  if (data?.token) tokenCache[pageId] = { t: data.token, at: Date.now() };
  return data?.token;
}

async function verifySignature(req: Request, raw: string): Promise<boolean> {
  const secret = Deno.env.get("META_APP_SECRET");
  if (!secret) return true;
  const sig = req.headers.get("x-hub-signature-256") || "";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === "sha256=" + hex;
}

type PageRow = { page_id: string; ig_user_id: string | null };
let pageCache: PageRow[] | null = null;
let pageCacheAt = 0;
async function pages(): Promise<PageRow[]> {
  if (!pageCache || Date.now() - pageCacheAt > 60000) {
    pageCacheAt = Date.now();
    const { data } = await sb.from("ib_pages").select("page_id, ig_user_id");
    pageCache = data || [];
  }
  return pageCache;
}

async function fetchProfile(platform: string, pageId: string, userId: string) {
  const token = await pageToken(pageId);
  if (!token) return {};
  const out: Record<string, string | null> = {};
  // 1. User Profile API: name + picture (picture needs Business Asset User Profile Access)
  const fields = platform === "instagram" ? "name,username,profile_pic" : "first_name,last_name,profile_pic";
  try {
    const j = await (await fetch(`${GRAPH}/${userId}?fields=${fields}&access_token=${token}`)).json();
    if (!j.error) {
      const name = platform === "instagram" ? (j.name || j.username) : [j.first_name, j.last_name].filter(Boolean).join(" ");
      if (name) out.name = name;
      if (j.profile_pic) out.profile_pic = j.profile_pic;
    }
  } catch { /* ignore */ }
  // 2. Conversations API: always gives the name, plus the thread id
  if (!out.name || platform === "messenger") {
    try {
      const plat = platform === "instagram" ? "instagram" : "messenger";
      const j = await (await fetch(`${GRAPH}/${pageId}/conversations?platform=${plat}&user_id=${userId}&fields=participants&access_token=${token}`)).json();
      const conv = j.data?.[0];
      const p = conv?.participants?.data?.find((x: any) => x.id === userId) || conv?.participants?.data?.find((x: any) => x.id !== pageId);
      if (!out.name && p?.name) out.name = p.name;
      if (!out.name && p?.username) out.name = p.username;
      if (conv?.id) out.thread_id = conv.id;
    } catch { /* ignore */ }
  }
  return out;
}

async function saveAd(pageId: string, ref: any) {
  const ctx = ref?.ads_context_data;
  const raw = ctx?.post_id;
  if (!raw) return null;
  const postId = String(raw).includes("_") ? String(raw) : `${pageId}_${raw}`;
  const { data: have } = await sb.from("ib_ads").select("post_id").eq("post_id", postId).maybeSingle();
  if (have) return postId;
  const row: Record<string, unknown> = { post_id: postId, page_id: pageId, ad_id: ref.ad_id || null, ad_title: ctx.ad_title || null, picture: ctx.photo_url || null };
  const token = await pageToken(pageId);
  if (token) {
    try {
      const j = await (await fetch(`${GRAPH}/${postId}?fields=message,full_picture,permalink_url,attachments{media_type}&access_token=${token}`)).json();
      if (!j.error) {
        row.message = j.message || null; row.picture = j.full_picture || row.picture; row.permalink = j.permalink_url || null;
        row.media_type = j.attachments?.data?.[0]?.media_type || null;
      }
    } catch { /* ignore */ }
  }
  await sb.from("ib_ads").upsert(row, { onConflict: "post_id" });
  return postId;
}

async function getConversation(platform: string, pageId: string, customerId: string) {
  let { data: contact } = await sb.from("ib_contacts").select("id, name, profile_pic")
    .eq("platform", platform).eq("page_id", pageId).eq("external_id", customerId).maybeSingle();
  let threadId: string | null = null;
  if (!contact || !contact.name) {
    const prof = await fetchProfile(platform, pageId, customerId);
    threadId = prof.thread_id || null;
    const row: Record<string, unknown> = { platform, page_id: pageId, external_id: customerId, name_checked_at: new Date().toISOString() };
    if (prof.name) row.name = prof.name;
    if (prof.profile_pic) row.profile_pic = prof.profile_pic;
    const ins = await sb.from("ib_contacts").upsert(row, { onConflict: "platform,page_id,external_id" }).select("id, name, profile_pic").single();
    contact = ins.data;
  }
  let { data: conv } = await sb.from("ib_conversations").select("*").eq("contact_id", contact!.id).maybeSingle();
  if (!conv) {
    const ins = await sb.from("ib_conversations").upsert(
      { contact_id: contact!.id, page_id: pageId, platform },
      { onConflict: "contact_id" },
    ).select("*").single();
    conv = ins.data;
  }
  if (threadId && !conv!.meta_thread_id) {
    await sb.from("ib_conversations").update({ meta_thread_id: threadId }).eq("id", conv!.id);
  }
  return conv!;
}

function attachmentsOf(msg: any) {
  const a = msg?.attachments;
  if (!a || !a.length) return null;
  return a.map((x: any) => ({ type: x.type, url: x.payload?.url || null, sticker_id: x.payload?.sticker_id || null, title: x.payload?.title || x.title || null }));
}

function previewText(text: string | null, att: any[] | null) {
  if (text) return text.slice(0, 300);
  if (att && att.length) return `[${att[0].type}]`;
  return "";
}

async function handleMessage(platform: string, pageId: string, ev: any) {
  const msg = ev.message;
  if (!msg && ev.referral && ev.sender?.id) {
    const conv = await getConversation(platform, pageId, ev.sender.id);
    const patch: Record<string, unknown> = {};
    if (ev.referral.ad_id && !conv.source_ad_id) patch.source_ad_id = ev.referral.ad_id;
    if (!conv.source_post_id) { const pid = await saveAd(pageId, ev.referral); if (pid) patch.source_post_id = pid; }
    if (Object.keys(patch).length) await sb.from("ib_conversations").update(patch).eq("id", conv.id);
    return;
  }
  if (!msg || !msg.mid) return;
  const isEcho = !!msg.is_echo;
  const customerId = isEcho ? ev.recipient?.id : ev.sender?.id;
  if (!customerId) return;

  // already stored (sent from CRM, or a duplicate webhook delivery)
  const { data: existing } = await sb.from("ib_messages").select("id").eq("meta_mid", msg.mid).maybeSingle();
  if (existing) return;

  const conv = await getConversation(platform, pageId, customerId);
  const text: string | null = msg.text ?? null;
  const att = attachmentsOf(msg);
  const sentAt = new Date(ev.timestamp || Date.now()).toISOString();

  if (isEcho) {
    // Was this sent from the CRM a moment ago and still waiting for its mid? Attach the mid instead of duplicating.
    const since = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    let pq = sb.from("ib_messages").select("id")
      .eq("conversation_id", conv.id).eq("direction", "out").is("meta_mid", null)
      .in("sender_type", ["moderator", "ai"]).gte("created_at", since);
    pq = text ? pq.eq("text", text) : pq.is("text", null).not("attachments", "is", null);
    const { data: pending } = await pq.order("created_at", { ascending: true }).limit(1);
    if (pending && pending.length) {
      await sb.from("ib_messages").update(att ? { meta_mid: msg.mid, attachments: att } : { meta_mid: msg.mid }).eq("id", pending[0].id);
      return;
    }
    // Sent from outside the CRM (Business Suite, phone app, other automation): stored, assignment unchanged.
    await sb.from("ib_messages").insert({
      conversation_id: conv.id, meta_mid: msg.mid, direction: "out", sender_type: "external",
      text, attachments: att, sent_at: sentAt, raw: ev,
    });
    await sb.from("ib_conversations").update({
      last_message_at: sentAt, last_message_text: previewText(text, att), last_message_dir: "out",
      last_outbound_at: sentAt, unread_count: 0,
    }).eq("id", conv.id);
    return;
  }

  // Inbound from the customer
  await sb.from("ib_messages").insert({
    conversation_id: conv.id, meta_mid: msg.mid, direction: "in", sender_type: "customer",
    text, attachments: att, sent_at: sentAt, raw: ev,
  });
  const patch: Record<string, unknown> = {
    last_message_at: sentAt, last_message_text: previewText(text, att), last_message_dir: "in",
    last_inbound_at: sentAt, unread_count: (conv.unread_count || 0) + 1,
    ai_analyzed_at: null, stage_locked_until: null, is_done: false,
  };
  // The customer wrote last, so it is our turn: never leave a "customer is silent" stage on it.
  const waiting = ["fresh_knock", "complaint_corner", "delivery_detective"];
  const locked = conv.stage_locked_until && new Date(conv.stage_locked_until).getTime() > Date.now() && conv.stage_set_by !== "ai" && conv.stage_set_by !== "system";
  if (!conv.stage_key || (!waiting.includes(conv.stage_key) && !locked)) {
    if (conv.stage_key && conv.stage_key !== "fresh_knock") {
      await sb.from("ib_stage_log").insert({ conversation_id: conv.id, from_stage: conv.stage_key, to_stage: "fresh_knock", set_by: "system" });
    }
    patch.stage_key = "fresh_knock"; patch.stage_set_at = sentAt; patch.stage_set_by = "system";
  }
  const ref = msg.referral || ev.referral;
  if (ref?.ad_id && !conv.source_ad_id) patch.source_ad_id = ref.ad_id;
  if (ref && !conv.source_post_id) {
    const postId = await saveAd(pageId, ref);
    if (postId) patch.source_post_id = postId;
  }
  await sb.from("ib_conversations").update(patch).eq("id", conv.id);
}

async function handleComment(platform: "facebook" | "instagram", pageId: string, v: any) {
  if (platform === "facebook") {
    if (v.item !== "comment") return;
    if (v.verb === "remove") { await sb.from("ib_comments").delete().eq("comment_id", v.comment_id); return; }
    if (v.from?.id === pageId) {
      // the page replied to a comment: mark the parent as replied
      if (v.parent_id) await sb.from("ib_comments").update({ replied: true }).eq("comment_id", v.parent_id);
      return;
    }
    await sb.from("ib_comments").upsert({
      comment_id: v.comment_id, page_id: pageId, platform, post_id: v.post_id, parent_id: v.parent_id !== v.post_id ? v.parent_id : null,
      from_id: v.from?.id, from_name: v.from?.name, message: v.message || "",
      created_time: new Date((v.created_time || Date.now() / 1000) * 1000).toISOString(), raw: v,
    }, { onConflict: "comment_id" });
  } else {
    await sb.from("ib_comments").upsert({
      comment_id: v.id, page_id: pageId, platform, post_id: v.media?.id, parent_id: v.parent_id || null,
      from_id: v.from?.id, from_name: v.from?.username, message: v.text || "",
      created_time: new Date().toISOString(), raw: v,
    }, { onConflict: "comment_id" });
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === Deno.env.get("META_VERIFY_TOKEN")) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok");

  const raw = await req.text();
  if (!(await verifySignature(req, raw))) return new Response("bad signature", { status: 401 });

  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("ok"); }

  try {
    const pgs = await pages();
    for (const entry of body.entry || []) {
      let platform: "messenger" | "instagram";
      let pageId: string | undefined;
      if (body.object === "page") { platform = "messenger"; pageId = entry.id; }
      else if (body.object === "instagram") { platform = "instagram"; pageId = pgs.find((p) => p.ig_user_id === entry.id)?.page_id; }
      else continue;
      if (!pageId || !pgs.find((p) => p.page_id === pageId)) continue;

      for (const ev of entry.messaging || []) await handleMessage(platform, pageId, ev);
      for (const ch of entry.changes || []) {
        if (body.object === "page" && ch.field === "feed") await handleComment("facebook", pageId, ch.value);
        if (body.object === "instagram" && ch.field === "comments") await handleComment("instagram", pageId, ch.value);
      }
    }
  } catch (e) {
    console.error("webhook error", e);
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
});

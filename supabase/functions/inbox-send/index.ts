// Omnichannel Inbox - send a reply or a bulk reminder batch.
// Body (single):  { conversation_id, text, username, as_ai? }
// Body (bulk):    { username, note?, items: [{ conversation_id, text, template_id? }] }
// Window rules:   < 24h since last customer message -> normal reply
//                 24h - 7 days -> HUMAN_AGENT tag (people only, never AI)
//                 > 7 days -> skipped, Meta does not allow it
import { createClient } from "npm:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const tokenCache: Record<string, { t: string; at: number }> = {};
async function pageToken(pageId: string): Promise<string | undefined> {
  const c = tokenCache[pageId];
  if (c && Date.now() - c.at < 5 * 60 * 1000) return c.t;
  const { data } = await sb.from("ib_page_tokens").select("token").eq("page_id", pageId).maybeSingle();
  if (data?.token) tokenCache[pageId] = { t: data.token, at: Date.now() };
  return data?.token;
}

async function sendOne(conversationId: string, text: string, username: string, asAi: boolean, att?: { type: string; url: string } | null) {
  const { data: conv } = await sb.from("ib_conversations")
    .select("*, ib_contacts(external_id)").eq("id", conversationId).maybeSingle();
  if (!conv) return { ok: false, error: "conversation_not_found" };
  if (conv.platform === "whatsapp") return { ok: false, error: "whatsapp_not_connected_yet" };

  const token = await pageToken(conv.page_id);
  if (!token) return { ok: false, error: "no_page_token" };

  const hours = conv.last_inbound_at ? (Date.now() - new Date(conv.last_inbound_at).getTime()) / 36e5 : Infinity;
  let messaging_type = "RESPONSE";
  let tag: string | undefined;
  if (hours >= 24 && hours < 168) {
    if (asAi) return { ok: false, error: "ai_outside_24h" };
    messaging_type = "MESSAGE_TAG"; tag = "HUMAN_AGENT";
  } else if (hours >= 168) {
    return { ok: false, error: "outside_7_day_window" };
  }

  const who = asAi ? "AI" : username;
  const now = new Date().toISOString();
  // Insert first, so the echo webhook can match this row instead of logging it as an outside message.
  const { data: row, error: insErr } = await sb.from("ib_messages").insert({
    conversation_id: conv.id, direction: "out", sender_type: asAi ? "ai" : "moderator", sent_by: who,
    text: text || null, attachments: att ? [att] : null, sent_at: now, send_status: "pending",
  }).select("id").single();
  if (insErr) return { ok: false, error: insErr.message };

  const payload: Record<string, unknown> = {
    recipient: { id: conv.ib_contacts.external_id },
    messaging_type,
    message: att ? { attachment: { type: att.type, payload: { url: att.url, is_reusable: true } } } : { text },
  };
  if (tag) payload.tag = tag;

  const r = await fetch(`${GRAPH}/${conv.page_id}/messages?access_token=${token}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (j.error) {
    await sb.from("ib_messages").update({ send_status: "failed", send_error: j.error.message }).eq("id", row.id);
    return { ok: false, error: j.error.message, message_id: row.id };
  }

  // the echo webhook may have attached the mid already; only fill it if still empty
  await sb.from("ib_messages").update({ send_status: "sent" }).eq("id", row.id);
  await sb.from("ib_messages").update({ meta_mid: j.message_id }).eq("id", row.id).is("meta_mid", null);

  const patch: Record<string, unknown> = {
    last_message_at: now, last_message_text: text ? text.slice(0, 300) : `[${att?.type || "attachment"}]`, last_message_dir: "out",
    last_outbound_at: now, unread_count: 0,
  };
  if (conv.assigned_to !== who) {
    patch.assigned_to = who; patch.assigned_at = now;
    await sb.from("ib_assignment_log").insert({
      conversation_id: conv.id, from_user: conv.assigned_to, to_user: who, reason: asAi ? "ai_replied" : "replied",
    });
  }
  await sb.from("ib_conversations").update(patch).eq("id", conv.id);
  return { ok: true, message_id: row.id, tagged: !!tag };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const username = String(body.username || "").trim();
  if (!username) return json({ error: "username required" }, 400);

  if (Array.isArray(body.items)) {
    const items = body.items.filter((i: any) => i && i.conversation_id && String(i.text || "").trim());
    const { data: batch } = await sb.from("ib_send_batches")
      .insert({ created_by: username, note: body.note || null, total: items.length }).select("id").single();
    let sent = 0, failed = 0;
    const results = [];
    for (const it of items) {
      const res = await sendOne(it.conversation_id, String(it.text), username, false);
      const status = res.ok ? "sent" : (String(res.error).startsWith("outside") ? "skipped" : "failed");
      if (res.ok) sent++; else failed++;
      await sb.from("ib_send_log").insert({
        batch_id: batch!.id, conversation_id: it.conversation_id, template_id: it.template_id || null,
        message_id: res.message_id || null, status, error: res.ok ? null : res.error,
      });
      results.push({ conversation_id: it.conversation_id, ...res });
      await new Promise((r) => setTimeout(r, 250)); // stay gentle with Meta rate limits
    }
    await sb.from("ib_send_batches").update({ sent, failed }).eq("id", batch!.id);
    return json({ batch_id: batch!.id, sent, failed, results });
  }

  if (body.react) {
    // React to a customer message from the Page: { react: { message_id (our id), reaction: love|smile|wow|sad|angry|like|"" } }
    const { data: m } = await sb.from("ib_messages").select("id, meta_mid, reactions, conversation_id").eq("id", body.react.message_id).maybeSingle();
    if (!m?.meta_mid) return json({ ok: false, error: "message_not_found" }, 422);
    const { data: conv } = await sb.from("ib_conversations").select("page_id, ib_contacts(external_id)").eq("id", m.conversation_id).maybeSingle();
    const token = conv && await pageToken(conv.page_id);
    if (!token) return json({ ok: false, error: "no_page_token" }, 422);
    const reaction = String(body.react.reaction || "");
    const payload = reaction
      ? { recipient: { id: (conv as any).ib_contacts.external_id }, sender_action: "react", payload: { message_id: m.meta_mid, reaction } }
      : { recipient: { id: (conv as any).ib_contacts.external_id }, sender_action: "unreact", payload: { message_id: m.meta_mid } };
    const j = await (await fetch(`${GRAPH}/${conv!.page_id}/messages?access_token=${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json();
    if (j.error) return json({ ok: false, error: j.error.message }, 422);
    const reactions = { ...(m.reactions || {}) };
    if (reaction) { reactions.page = reaction; reactions.page_by = username; } else { delete reactions.page; delete reactions.page_by; }
    await sb.from("ib_messages").update({ reactions }).eq("id", m.id);
    return json({ ok: true });
  }

  const text = String(body.text || "").trim();
  const att = body.attachment_url ? { type: ["image", "video", "audio", "file"].includes(body.attachment_type) ? body.attachment_type : "file", url: String(body.attachment_url) } : null;
  if (!body.conversation_id || (!text && !att)) return json({ error: "conversation_id and text or attachment required" }, 400);
  const res = await sendOne(body.conversation_id, att ? "" : text, username, !!body.as_ai, att);
  return json(res, res.ok ? 200 : 422);
});

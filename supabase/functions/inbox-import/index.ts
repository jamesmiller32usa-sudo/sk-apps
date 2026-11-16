// Omnichannel Inbox - import past Messenger conversations from the Graph API.
// Body: { page_id, since: "2026-11-01", after?: "<cursor>", limit?: 50 }
// Processes one page of conversations per call (bulk writes) and returns { next } so the caller can loop.
// Meta returns at most the latest 20 messages per conversation.
// Never overwrites newer data written by the live webhook.
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

async function pageToken(pageId: string): Promise<string | undefined> {
  const { data } = await sb.from("ib_page_tokens").select("token").eq("page_id", pageId).maybeSingle();
  return data?.token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const pageId: string = body.page_id;
  const since = new Date(body.since || "2026-11-01T00:00:00+06:00");
  const limit = Math.min(Number(body.limit) || 50, 100);
  const token = pageId ? await pageToken(pageId) : undefined;
  if (!pageId || !token) return json({ error: "page_id missing or no token for it" }, 400);

  const fields = "id,updated_time,participants,messages.limit(20){id,message,from,created_time,attachments{mime_type,image_data,file_url,name}}";
  let url = `${GRAPH}/${pageId}/conversations?platform=messenger&limit=${limit}&fields=${encodeURIComponent(fields)}&access_token=${token}`;
  if (body.after) url += `&after=${encodeURIComponent(body.after)}`;
  const j = await (await fetch(url)).json();
  if (j.error) return json({ error: j.error.message }, 502);

  const convs = (j.data || []).filter((c: any) => new Date(c.updated_time) >= since);
  const reachedEnd = convs.length < (j.data || []).length;
  const items = convs.map((c: any) => ({
    c, customer: (c.participants?.data || []).find((p: any) => p.id !== pageId),
  })).filter((x: any) => x.customer);

  if (!items.length) return json({ imported: 0, messages: 0, next: reachedEnd ? null : j.paging?.cursors?.after || null });

  // 1. contacts (bulk)
  const { data: contacts, error: e1 } = await sb.from("ib_contacts").upsert(
    items.map((x: any) => ({ platform: "messenger", page_id: pageId, external_id: x.customer.id, name: x.customer.name || null })),
    { onConflict: "platform,page_id,external_id" },
  ).select("id, external_id");
  if (e1) return json({ error: "contacts: " + e1.message }, 500);
  const contactId: Record<string, string> = {};
  for (const ct of contacts || []) contactId[ct.external_id] = ct.id;

  // 2. existing conversations (keep newer live data)
  const ids = Object.values(contactId);
  const { data: existing } = await sb.from("ib_conversations").select("id, contact_id, last_message_at, stage_key").in("contact_id", ids);
  const exByContact: Record<string, any> = {};
  for (const e of existing || []) exByContact[e.contact_id] = e;

  const convRows = items.map((x: any) => {
    const list = (x.c.messages?.data || []);           // newest first
    const last = list[0];
    const lastIn = list.find((m: any) => m.from?.id !== pageId);
    const lastOut = list.find((m: any) => m.from?.id === pageId);
    const cid = contactId[x.customer.id];
    const ex = exByContact[cid];
    const row: Record<string, unknown> = { contact_id: cid, page_id: pageId, platform: "messenger", meta_thread_id: x.c.id };
    const newer = !ex || !ex.last_message_at || (last && new Date(last.created_time) > new Date(ex.last_message_at));
    if (last && newer) {
      Object.assign(row, {
        last_message_at: last.created_time,
        last_message_text: (last.message || "[attachment]").slice(0, 300),
        last_message_dir: last.from?.id === pageId ? "out" : "in",
        last_inbound_at: lastIn?.created_time || null,
        last_outbound_at: lastOut?.created_time || null,
      });
      if (!ex?.stage_key) row.stage_set_at = last.created_time;
    }
    return row;
  });
  // rows in one bulk upsert must share the same keys, otherwise missing columns become NULL
  const groups: Record<string, any[]> = {};
  for (const r of convRows) { const sig = Object.keys(r).sort().join(","); (groups[sig] ||= []).push(r); }
  const convIdByContact: Record<string, string> = {};
  for (const batch of Object.values(groups)) {
    if (!batch.length) continue;
    const { data, error } = await sb.from("ib_conversations").upsert(batch, { onConflict: "contact_id" }).select("id, contact_id");
    if (error) return json({ error: "conversations: " + error.message }, 500);
    for (const r of data || []) convIdByContact[r.contact_id] = r.id;
  }

  // 3. messages (bulk, skip ones already stored)
  const msgRows: any[] = [];
  for (const x of items) {
    const convId = convIdByContact[contactId[x.customer.id]];
    for (const m of x.c.messages?.data || []) {
      const out = m.from?.id === pageId;
      const att = (m.attachments?.data || []).map((a: any) => ({
        type: a.mime_type?.startsWith("image") ? "image" : "file",
        url: a.image_data?.url || a.file_url || null, name: a.name || null,
      }));
      msgRows.push({
        conversation_id: convId, meta_mid: m.id, direction: out ? "out" : "in",
        sender_type: out ? "external" : "customer", text: m.message || null,
        attachments: att.length ? att : null, sent_at: m.created_time,
      });
    }
  }
  if (msgRows.length) {
    const { error } = await sb.from("ib_messages").upsert(msgRows, { onConflict: "meta_mid", ignoreDuplicates: true });
    if (error) return json({ error: "messages: " + error.message }, 500);
  }

  return json({ imported: items.length, messages: msgRows.length, next: reachedEnd ? null : j.paging?.cursors?.after || null });
});

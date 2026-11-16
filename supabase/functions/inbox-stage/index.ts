// Omnichannel Inbox - stage detection.
// Runs every 2 minutes (pg_cron). Picks conversations whose newest message is newer than their last analysis,
// skips ones a moderator locked by hand, and sets stage_key + stage_set_at (= when the silence started).
// Rule-based for now (tuned on real Sharangakutir / Sanatani Mart / Decor Your Home chats).
// If OPENAI_API_KEY is set later, the same entry point can be switched to an LLM.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

type Msg = { direction: "in" | "out"; text: string | null; attachments: any; sent_at: string };

const NOISE = /Lead stage set|Auto-label added|You are responding to a user comment|This automated reply|thanks for contacting us|currently away|Please let us know how we can help/i;
const R = {
  complaint: /ভাঙ|ফাটা|নষ্ট|damage|broken|vanga|nosto|kharap|খারাপ|ভুল (ডিজাইন|প্রোডাক্ট)|complain|অভিযোগ|refund|ফেরত/i,
  delivery: /parcel|পার্সেল|কবে পা(ব|বো)|kobe pab|ekhono pai|এখনো পাই|pai ni|পাইনি|courier|কুরিয়ার|steadfast|tracking|delivery kobe|ডেলিভারি কবে/i,
  orderDone: /order has been Received|অর্ডারটি কনফার্ম হয়েছে|অর্ডার কনফার্ম হয়েছে|কার্যদিবসের মধ্যে হাতে পাবেন|Wallboard\/Canvas টি পাওয়ার পর|টেপ লাগানোর ভিডিও|Due payment/i,
  askAddress: /অর্ডারটি কনফার্ম করতে|নিচের ফর্ম|ঠিকানা দিন|ঠিকানা টি|ঠিকানাটা|address dmin|address din|full address|নাম, ঠিকানা|মোবাইল নাম্বার দিন|লোকেশন টি জানাবেন|location/i,
  bkashOut: /বিকাশ|bkash|নগদ|nagad|অগ্রিম (টাকা )?(পাঠান|দিন|দিতে হবে)|advance (din|pathan|den)/i,
  noAdvance: /অগ্রিম টাকা দিতে হবেনা/i,
  bkashIn: /bkash (kor|dicchi|dibo|korbo)|বিকাশ (করব|করছি|দিব|দিচ্ছি)|টাকা পাঠা(ব|চ্ছি)|send kor(bo|chi)/i,
  later: /janabo|জানাব|জানাবো|vebe|ভেবে|pore (nibo|janabo)|পরে (নিব|জানাব)|ektu (pore|por)|দেখি|dekhi|bolbo|বলব/i,
  bargain: /kom (hobe|koren|korun)|কম (হবে|করেন|করা)|discount|ডিসকাউন্ট|komano|কমানো|last price|লাস্ট প্রাইস|ar kom|আর কম|beshi dam|বেশি দাম/i,
  designIn: /pic dib|chobi dib|ছবি দিব|ছবি দিচ্ছি|ছবি পাঠাব|design dib|ডিজাইন দিব|pathacchi|পাঠাচ্ছি|দিচ্ছি/i,
  designOut: /ছবি দিয়ে|ছবি দিন|ছবিটি দিন|picture din|pic din|ডিজাইন পাঠান|স্ক্রিনশট দিন|screenshot din|কোন সেট টি নিতে|নাম লিখে দিন|নামটি লিখে|name din/i,
  mockupOut: /mockup|মকআপ|ডিজাইন রেডি|design ready|ডিজাইনটি দেখুন|কেমন হয়েছে|ঠিক আছে কিনা|ok ache kina/i,
  sizeIn: /size|সাইজ|ইঞ্চি|inch|কত বড়|koto boro|মাপ/i,
  price: /\d+\s*(tk|৳|bdt|taka|টাকা)|[০-৯]+\s*(টাকা|৳)|price|দাম|prize|offer|অফার/i,
  askSize: /কোন সাইজ|kon size|সাইজটি|size er niben|size ti/i,
};

function hasImage(m: Msg) { return Array.isArray(m.attachments) && m.attachments.some((a: any) => a?.type === "image"); }

function classify(all: Msg[]): { stage: string; since: string; why: string } | null {
  const msgs = all.filter((m) => !(m.direction === "out" && m.text && NOISE.test(m.text)));
  if (!msgs.length) return null;
  const last = msgs[0];
  const lastIn = msgs.find((m) => m.direction === "in");
  const t = (m?: Msg) => (m?.text || "");

  if (last.direction === "in") {
    // waiting for us: clock starts at the first unanswered customer message
    const unanswered: Msg[] = [];
    for (const m of msgs) { if (m.direction === "in") unanswered.push(m); else break; }
    const since = unanswered[unanswered.length - 1].sent_at;
    const joined = unanswered.map(t).join(" ");
    if (R.complaint.test(joined)) return { stage: "complaint_corner", since, why: "customer complaint" };
    if (R.delivery.test(joined)) return { stage: "delivery_detective", since, why: "asking about delivery" };
    return { stage: "fresh_knock", since, why: "customer waiting for reply" };
  }

  // last message is ours: customer is silent since our first message after their last one
  const outs: Msg[] = [];
  for (const m of msgs) { if (m.direction === "out") outs.push(m); else break; }
  const since = outs[outs.length - 1].sent_at;
  const outText = outs.map(t).join(" ");
  const inText = msgs.filter((m) => m.direction === "in").slice(0, 3).map(t).join(" ");
  const recentOut = msgs.filter((m) => m.direction === "out").slice(0, 6).map(t).join(" ");

  if (lastIn && Date.now() - new Date(lastIn.sent_at).getTime() > 7 * 864e5)
    return { stage: "lost_soul", since, why: "no reply for over 7 days" };
  if (R.orderDone.test(outText)) return { stage: "order_locked", since, why: "order confirmation sent" };
  if (R.complaint.test(t(lastIn))) return { stage: "complaint_corner", since, why: "complaint thread" };
  if (R.bkashIn.test(inText)) return { stage: "bkash_promise", since, why: "customer said they will pay" };
  if (R.bkashOut.test(outText) && !R.noAdvance.test(outText)) return { stage: "bkash_promise", since, why: "advance payment requested" };
  if (R.askAddress.test(outText)) return { stage: "address_hide", since, why: "address / order form requested" };
  if (R.later.test(t(lastIn))) return { stage: "philosopher", since, why: "customer said they will think" };
  if (R.bargain.test(inText)) return { stage: "bargain_boss", since, why: "customer bargained" };
  if (outs.some(hasImage) && (R.mockupOut.test(outText) || !R.price.test(outText))) return { stage: "mockup_silence", since, why: "design/mockup sent" };
  if (R.designIn.test(t(lastIn)) || R.designOut.test(outText)) return { stage: "design_dreamer", since, why: "waiting for customer's design/photo" };
  if (R.sizeIn.test(t(lastIn)) && !R.price.test(recentOut)) return { stage: "size_puzzler", since, why: "size question answered" };
  if (R.price.test(recentOut) || R.askSize.test(outText)) return { stage: "price_ghost", since, why: "price shared, no reply" };
  return { stage: "seen_zoned", since, why: "no reply to our message" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Number(body.limit) || 400, 1000);

  const { data: ids, error } = await sb.rpc("ib_pending_stage", { p_limit: limit });
  if (error) return Response.json({ error: error.message }, { headers: cors, status: 500 });
  const convIds = (ids || []).map((r: any) => r.id);
  if (!convIds.length) return Response.json({ processed: 0 }, { headers: cors });

  const { data: convs } = await sb.from("ib_conversations").select("id, stage_key").in("id", convIds);
  const current: Record<string, string | null> = {};
  for (const c of convs || []) current[c.id] = c.stage_key;

  let changed = 0;
  const now = new Date().toISOString();
  // fetch recent messages in chunks
  for (let i = 0; i < convIds.length; i += 50) {
    const chunk = convIds.slice(i, i + 50);
    const { data: rows } = await sb.rpc("ib_recent_messages", { p_ids: chunk, p_per: 12 });
    const byConv: Record<string, Msg[]> = {};
    for (const r of rows || []) (byConv[r.conversation_id] ||= []).push(r);
    for (const id of chunk) {
      const list = (byConv[id] || []).sort((a, b) => b.sent_at.localeCompare(a.sent_at));
      const res = classify(list);
      const patch: Record<string, unknown> = { ai_analyzed_at: now };
      if (res) {
        patch.ai_summary = res.why;
        if (res.stage !== current[id]) {
          patch.stage_key = res.stage; patch.stage_set_at = res.since; patch.stage_set_by = "ai";
          await sb.from("ib_stage_log").insert({ conversation_id: id, from_stage: current[id], to_stage: res.stage, set_by: "ai" });
          changed++;
        } else {
          patch.stage_set_at = res.since; // same stage, but the silence clock may have moved
        }
      }
      await sb.from("ib_conversations").update(patch).eq("id", id);
    }
  }
  return Response.json({ processed: convIds.length, changed }, { headers: cors });
});

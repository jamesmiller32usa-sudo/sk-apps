-- =====================================================================
-- Omnichannel Inbox - Step 1 schema
-- Project: Sharangakutir CRM (Supabase ref dkwlsfzysjdubcwuemvx)
-- All tables prefixed ib_ so nothing collides with existing CRM tables.
-- Page access tokens are NOT stored here; they live in Edge Function secrets.
-- =====================================================================

-- 1. Connected pages / accounts ---------------------------------------
create table if not exists ib_pages (
  page_id      text primary key,            -- Facebook Page ID
  name         text not null,               -- Decor Your Home / Sanatani Mart / Sharangakutir
  short_code   text not null unique,        -- DYH / SM / SK (used in filters and badges)
  ig_user_id   text,                        -- linked Instagram business account (only SK for now)
  ig_username  text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- 2. Stages (AI sets them, moderators can override) --------------------
create table if not exists ib_stages (
  key          text primary key,
  name         text not null,
  description  text,
  sla_minutes  int  not null default 120,   -- per-stage "stuck" threshold, editable by admin
  sort_order   int  not null default 0,
  is_closed    boolean not null default false, -- e.g. Order Locked: never counted as stuck
  active       boolean not null default true
);

insert into ib_stages (key, name, description, sla_minutes, sort_order, is_closed) values
 ('fresh_knock',     'Fresh Knock',         'New message, not replied yet',                        15,   1, false),
 ('price_ghost',     'Price Ghost',         'Got the price, then went silent',                     120,  2, false),
 ('design_dreamer',  'Design Daydreamer',   'Said they would send a design, never did',            120,  3, false),
 ('bkash_promise',   'bKash Promise',       'Said they would pay advance by bKash, never did',     120,  4, false),
 ('size_puzzler',    'Size Puzzler',        'Asked about size, then stopped',                      120,  5, false),
 ('address_hide',    'Address Hide & Seek', 'Said they would send the address, never did',         120,  6, false),
 ('philosopher',     'The Philosopher',     'Said they will think and let us know',                240,  7, false),
 ('bargain_boss',    'Bargain Boss',        'Bargained on price, then left',                       180,  8, false),
 ('mockup_silence',  'Mockup Silence',      'Saw the mockup, no reply',                            120,  9, false),
 ('seen_zoned',      'Seen Zoned',          'Seen our message, no reply',                          120, 10, false),
 ('almost_mine',     'Almost Mine',         'Everything settled, only confirmation pending',       60,  11, false),
 ('order_locked',    'Order Locked',        'Order confirmed',                                     0,   12, true),
 ('delivery_detective','Delivery Detective','Asking where the parcel is',                          60,  13, false),
 ('complaint_corner','Complaint Corner',    'Complaint or problem with an order',                  30,  14, false),
 ('lost_soul',       'Lost Soul',           'Silent even after 2-3 follow-ups',                    0,   15, true)
on conflict (key) do nothing;

-- 3. Contacts (one row per person per page per platform) --------------
create table if not exists ib_contacts (
  id           uuid primary key default gen_random_uuid(),
  platform     text not null check (platform in ('messenger','instagram','whatsapp')),
  page_id      text not null references ib_pages(page_id),
  external_id  text not null,               -- PSID / IGSID / WhatsApp number
  name         text,
  profile_pic  text,
  phone        text,
  created_at   timestamptz not null default now(),
  unique (platform, page_id, external_id)
);

-- 4. Conversations ------------------------------------------------------
create table if not exists ib_conversations (
  id                  uuid primary key default gen_random_uuid(),
  contact_id          uuid not null references ib_contacts(id) on delete cascade,
  page_id             text not null references ib_pages(page_id),
  platform            text not null check (platform in ('messenger','instagram','whatsapp')),
  meta_thread_id      text unique,          -- Graph API conversation id (t_xxx), when known
  last_message_at     timestamptz,
  last_message_text   text,
  last_message_dir    text check (last_message_dir in ('in','out')),
  last_inbound_at     timestamptz,          -- drives the 24h / 7-day send window
  last_outbound_at    timestamptz,
  unread_count        int not null default 0,
  assigned_to         text,                 -- CRM username, 'AI', or null
  assigned_at         timestamptz,
  stage_key           text references ib_stages(key),
  stage_set_at        timestamptz,          -- the "time in stage" clock starts here
  stage_set_by        text,                 -- 'ai' or a username
  stage_locked_until  timestamptz,          -- a manual override wins over AI until the next inbound message
  ai_summary          text,
  ai_analyzed_at      timestamptz,
  is_done             boolean not null default false,
  source_ad_id        text,                 -- ad_id when the chat started from an ad
  created_at          timestamptz not null default now(),
  unique (contact_id)
);
create index if not exists ib_conv_last_msg_idx on ib_conversations (last_message_at desc);
create index if not exists ib_conv_page_idx     on ib_conversations (page_id, platform);
create index if not exists ib_conv_assign_idx   on ib_conversations (assigned_to);
create index if not exists ib_conv_stage_idx    on ib_conversations (stage_key, stage_set_at);

-- 5. Messages -----------------------------------------------------------
create table if not exists ib_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references ib_conversations(id) on delete cascade,
  meta_mid         text unique,             -- Meta message id, used to drop duplicates and echoes
  direction        text not null check (direction in ('in','out')),
  sender_type      text not null check (sender_type in ('customer','moderator','ai','external','system')),
  sent_by          text,                    -- CRM username for moderator, 'AI' for ai, null otherwise
  text             text,
  attachments      jsonb,
  sent_at          timestamptz not null,
  send_status      text not null default 'sent' check (send_status in ('pending','sent','failed')),
  send_error       text,
  raw              jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists ib_msg_conv_idx on ib_messages (conversation_id, sent_at);

-- 6. Comments (Facebook + Instagram) -----------------------------------
create table if not exists ib_comments (
  comment_id       text primary key,
  page_id          text not null references ib_pages(page_id),
  platform         text not null check (platform in ('facebook','instagram')),
  post_id          text,
  parent_id        text,
  from_id          text,
  from_name        text,
  message          text,
  created_time     timestamptz not null,
  replied          boolean not null default false,
  private_replied  boolean not null default false,
  assigned_to      text,
  is_hidden        boolean not null default false,
  raw              jsonb,
  created_at       timestamptz not null default now()
);
create index if not exists ib_comments_time_idx on ib_comments (created_time desc);

-- 7. Assignment history -------------------------------------------------
create table if not exists ib_assignment_log (
  id               bigserial primary key,
  conversation_id  uuid not null references ib_conversations(id) on delete cascade,
  from_user        text,
  to_user          text,
  reason           text,                    -- 'replied', 'manual', 'ai_replied'
  at               timestamptz not null default now()
);

-- 8. Stage history (useful later for funnel analysis) ------------------
create table if not exists ib_stage_log (
  id               bigserial primary key,
  conversation_id  uuid not null references ib_conversations(id) on delete cascade,
  from_stage       text,
  to_stage         text,
  set_by           text,
  at               timestamptz not null default now()
);

-- 9. Reminder templates -------------------------------------------------
create table if not exists ib_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  body        text not null,
  stage_key   text references ib_stages(key),   -- optional suggestion per stage
  page_id     text references ib_pages(page_id), -- optional: page-specific template
  active      boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now()
);

-- 10. Bulk reminder sends ----------------------------------------------
create table if not exists ib_send_batches (
  id           uuid primary key default gen_random_uuid(),
  created_by   text not null,
  note         text,
  total        int  not null default 0,
  sent         int  not null default 0,
  failed       int  not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists ib_send_log (
  id               bigserial primary key,
  batch_id         uuid not null references ib_send_batches(id) on delete cascade,
  conversation_id  uuid not null references ib_conversations(id) on delete cascade,
  template_id      uuid references ib_templates(id),
  message_id       uuid references ib_messages(id),
  status           text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  error            text,
  at               timestamptz not null default now()
);

-- 11. Live updates for the inbox UI ------------------------------------
alter publication supabase_realtime add table ib_conversations;
alter publication supabase_realtime add table ib_messages;
alter publication supabase_realtime add table ib_comments;

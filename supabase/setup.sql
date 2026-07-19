-- ============================================================
-- Haven OS — one-paste database setup.
--
-- Run this ONCE in the Supabase web SQL editor (Dashboard → SQL
-- Editor → paste → Run). It is idempotent: running it again is
-- safe and changes nothing.
--
-- It creates every table, index and function the app uses, and
-- seeds exactly three things: the room catalogue, and the memory
-- type/category reference lists. No content ships here — canon,
-- memories, themes, keys and names are all born in the app's own
-- setup wizard and Fuse Box panels.
--
-- Generated from the live source schema on 19 Jul 2026. A note on
-- identifiers: the role values 'elle'/'jay' and the image-door
-- values 'elle'/'vosjay'/'chatjay' are STABLE INTERNAL SLUGS
-- meaning user/companion/connector — every display surface
-- resolves the names you configure; these strings never surface.
-- ============================================================

-- pgvector for the memory layer's embeddings (1536-dim).
create extension if not exists vector with schema extensions;

-- ── Rooms + conversation spine ──────────────────────────────

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (name = any (array[
    'front_room','gallery','listening_room','workshop','notebook',
    'bedroom','hearth','games_room','post_box'])),
  state jsonb not null default '{}'::jsonb,
  last_entered_at timestamptz,
  display_name text,
  icon text,
  sort_order integer,
  status text not null default 'soon'
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete restrict,
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  state text not null default 'active'
    check (state = any (array['active','archived','ended']))
);
create index if not exists conversations_room_id_idx on conversations (room_id);
create index if not exists conversations_last_active_at_idx on conversations (last_active_at desc);
create unique index if not exists one_active_conversation_per_room
  on conversations (room_id) where (state = 'active');

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role = any (array['elle','jay','system'])),
  content text not null default '',
  content_modality text not null default 'text'
    check (content_modality = any (array['text','voice','image','system_event'])),
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists messages_conversation_id_created_at_idx
  on messages (conversation_id, created_at);

-- ── Config + identity ───────────────────────────────────────

create table if not exists preferences (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists prompt_versions (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  is_active boolean not null default false,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists prompt_versions_one_active
  on prompt_versions (is_active) where is_active;

create table if not exists decor_theme_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) >= 1 and length(trim(name)) <= 40),
  tokens jsonb not null,
  note text,
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists decor_theme_versions_one_active
  on decor_theme_versions (is_active) where is_active;

-- ── The memory layer ────────────────────────────────────────

create table if not exists types (
  name text primary key,
  description text not null
);

create table if not exists categories (
  name text primary key,
  description text
);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  type text not null references types(name) on update cascade,
  category text not null references categories(name) on update cascade,
  title text not null,
  content text not null,
  core boolean not null default false,
  active boolean not null default true,
  entry_date date,
  tags text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  embedding vector(1536),
  constraint memories_entry_date_matches_type
    check ((type = any (array['daily','weekly'])) = (entry_date is not null))
);

create table if not exists awareness_signals (
  id uuid primary key default gen_random_uuid(),
  signal_type text not null check (signal_type = any (array[
    'calendar_event','spotify_play','notion_change','location_change','ha_state','mood_status'])),
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed boolean not null default false
);
create index if not exists awareness_signals_processed_received_at_idx
  on awareness_signals (processed, received_at);

create table if not exists tier_fires (
  id uuid primary key default gen_random_uuid(),
  tier integer not null check (tier >= 1 and tier <= 4),
  trigger text not null,
  fired_at timestamptz not null default now(),
  message_id uuid references messages(id) on delete set null,
  suppressed boolean not null default false,
  suppression_reason text
);
create index if not exists tier_fires_fired_at_idx on tier_fires (fired_at desc);

-- ── The Gallery ─────────────────────────────────────────────

create table if not exists gallery_references (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  kind text not null check (kind = any (array['character','location'])),
  display_name text not null,
  description text not null,
  storage_path text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists images (
  id uuid primary key,
  source text not null check (source = any (array['elle','vosjay','chatjay'])),
  status text not null default 'pending'
    check (status = any (array['pending','complete','error'])),
  error text,
  prompt_raw text not null,
  prompt_rendered text,
  model text not null,
  aspect_ratio text,
  resolution text,
  output_format text not null default 'png',
  storage_path text,
  thumbnail_path text,
  width integer,
  height integer,
  cost numeric,
  reference_images jsonb,
  tags text[] not null default '{}'::text[],
  favourite boolean not null default false,
  conversation_id uuid references conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  path text not null default 'verbatim' check (path = any (array['verbatim','authored'])),
  attempted_at timestamptz not null default now()
);
create index if not exists images_created_at_idx on images (created_at desc);
create index if not exists images_status_idx on images (status);
create index if not exists images_favourite_idx on images (favourite) where favourite;

-- ── Mirrors + operational state (empty until their workers run) ──

create table if not exists calendar_mirror (
  id bigint generated by default as identity primary key,
  source text not null,
  source_id text not null,
  kind text not null,
  title text not null,
  course text,
  category text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  is_datetime boolean default false,
  due_at timestamptz,
  recurs_annual boolean default false,
  url text,
  synced_at timestamptz not null default now(),
  unique (source, source_id)
);
create index if not exists calendar_mirror_starts_at_idx on calendar_mirror (starts_at);
create index if not exists calendar_mirror_due_at_idx on calendar_mirror (due_at);

create table if not exists sync_health (
  worker text primary key,
  ran_at timestamptz not null default now(),
  ok boolean not null,
  error text,
  items integer,
  last_ok_at timestamptz
);

create table if not exists push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  auth_fail_count integer not null default 0
);

create table if not exists postbox_sync_state (
  id integer primary key default 1 check (id = 1),
  last_internal_date bigint not null default 0,
  updated_at timestamptz not null default now(),
  last_pushed_internal_date bigint
);

-- ── Row level security: service-role only, everywhere, on purpose.
-- The Worker holds the service key; no anon policies exist at all. ──

alter table rooms enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table preferences enable row level security;
alter table prompt_versions enable row level security;
alter table decor_theme_versions enable row level security;
alter table types enable row level security;
alter table categories enable row level security;
alter table memories enable row level security;
alter table awareness_signals enable row level security;
alter table tier_fires enable row level security;
alter table gallery_references enable row level security;
alter table images enable row level security;
alter table calendar_mirror enable row level security;
alter table sync_health enable row level security;
alter table push_subscriptions enable row level security;
alter table postbox_sync_state enable row level security;

-- ── Functions (the app's RPCs) ──────────────────────────────

create or replace function save_prompt_version(p_content text, p_note text default null)
returns uuid
language plpgsql
as $$
declare vid uuid;
begin
  if p_content is null or length(trim(p_content)) = 0 then
    raise exception 'prompt content must not be empty';
  end if;
  insert into prompt_versions (content, note) values (p_content, p_note) returning id into vid;
  update prompt_versions set is_active = false where is_active;
  update prompt_versions set is_active = true where id = vid;
  return vid;
end
$$;

create or replace function activate_prompt_version(p_id uuid)
returns void
language plpgsql
as $$
begin
  if not exists (select 1 from prompt_versions where id = p_id) then
    raise exception 'no prompt version with id %', p_id;
  end if;
  update prompt_versions set is_active = false where is_active;
  update prompt_versions set is_active = true where id = p_id;
end
$$;

create or replace function save_decor_version(p_name text, p_tokens jsonb, p_note text default null)
returns uuid
language plpgsql
as $$
declare
  vid uuid;
  was_active boolean;
begin
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'theme name must not be empty';
  end if;
  if p_tokens is null or jsonb_typeof(p_tokens) <> 'object' then
    raise exception 'theme tokens must be a json object';
  end if;
  select exists (
    select 1 from decor_theme_versions where name = trim(p_name) and is_active
  ) into was_active;
  insert into decor_theme_versions (name, tokens, note)
  values (trim(p_name), p_tokens, p_note)
  returning id into vid;
  if was_active then
    update decor_theme_versions set is_active = false where is_active;
    update decor_theme_versions set is_active = true where id = vid;
  end if;
  return vid;
end
$$;

create or replace function activate_decor_version(p_id uuid)
returns void
language plpgsql
as $$
begin
  if not exists (select 1 from decor_theme_versions where id = p_id) then
    raise exception 'no decor version with id %', p_id;
  end if;
  update decor_theme_versions set is_active = false where is_active;
  update decor_theme_versions set is_active = true where id = p_id;
end
$$;

create or replace function deactivate_decor()
returns void
language plpgsql
as $$
begin
  update decor_theme_versions set is_active = false where is_active;
end
$$;

create or replace function match_memories(
  query_embedding vector,
  match_count integer,
  match_threshold double precision,
  include_scene boolean default false
)
returns setof memories
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select *
  from memories
  where active = true
    and core = false                            -- spine is handled separately
    and type <> 'resolved'                      -- resolved is direct-relevance only, not ambient
    and (type <> 'roleplay' or include_scene)   -- roleplay only when scene mode is flagged
    and (embedding <=> query_embedding) < (1 - match_threshold)  -- <=> is cosine distance
  order by embedding <=> query_embedding asc
  limit least(match_count, 50);
$$;

create or replace function match_memory_for_dedup(query_embedding vector, target_category text)
returns table(
  id uuid, type text, core boolean, active boolean, title text, content text,
  tags text[], similarity double precision, updated_at timestamptz
)
language sql
stable
set search_path to 'public', 'extensions'
as $$
  select
    m.id, m.type, m.core, m.active, m.title, m.content, m.tags,
    1 - (m.embedding <=> query_embedding) as similarity,  -- <=> is cosine distance
    m.updated_at
  from memories m
  where m.active = true
    and m.category = target_category
    and m.embedding is not null
  order by m.embedding <=> query_embedding asc
  limit 1;
$$;

create or replace function read_calendar(start_date date, end_date date)
returns setof calendar_mirror
language sql
stable
set search_path to 'public'
as $$
  select *
  from calendar_mirror
  where (starts_at::date between start_date and end_date)
     or (due_at::date between start_date and end_date)
  order by coalesce(starts_at, due_at);
$$;

-- ── Seeds — structure only, never content ───────────────────

-- The room catalogue. Haven v1 opens four rooms + the Fuse Box (which is a
-- panel, not a room row); the rest of the catalogue ships dormant ('soon') —
-- present in the drawer, inert until a future update opens one.
insert into rooms (name, display_name, icon, sort_order, status) values
  ('front_room',     'Front Room',     'ti-message-circle',   1, 'live'),
  ('workshop',       'Workshop',       'ti-tools',            2, 'live'),
  ('hearth',         'The Hearth',     'ti-home',             3, 'live'),
  ('gallery',        'Gallery',        'ti-photo',            4, 'live'),
  ('post_box',       'Post Box',       'ti-mail',             5, 'soon'),
  ('listening_room', 'Listening Room', 'ti-headphones',       6, 'soon'),
  ('notebook',       'Notebook',       'ti-book',             7, 'soon'),
  ('bedroom',        'Bedroom',        'ti-moon',             8, 'soon'),
  ('games_room',     'Games Room',     'ti-device-gamepad-2', 9, 'soon')
on conflict (name) do nothing;

-- Memory taxonomy reference lists (the write_memory / curation vocabulary).
insert into types (name, description) values
  ('anchor',   'definitional facts about the companion or the two of you'),
  ('canon',    'definitional facts about the user'),
  ('daily',    'a daily snapshot / journal entry, one per day the companion writes one'),
  ('weekly',   'a weekly rollup, generated from the week''s daily entries'),
  ('resolved', 'memories that were active for a period but whose subject has concluded'),
  ('roleplay', 'scene context, dynamic specifics')
on conflict (name) do nothing;

insert into categories (name) values
  ('dynamic'), ('general'), ('health'), ('identity'), ('leisure'), ('lore'),
  ('patterns'), ('people'), ('places'), ('preferences'), ('projects'),
  ('rituals'), ('routines'), ('stressors'), ('systems'), ('work')
on conflict (name) do nothing;

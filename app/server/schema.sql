-- Senju: accounts, teams, memory and history.
-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Sign-up itself is Supabase Auth; this adds what hangs off a user.

create extension if not exists pgcrypto;

-- ---- People and teams ---------------------------------------------------------------------

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- A profile is created for every new account, named from the sign-up form.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'name'), ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text unique not null default encode(gen_random_bytes(6), 'hex'),
  created_by uuid references profiles,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  team_id uuid not null references teams on delete cascade,
  user_id uuid not null references profiles on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table if not exists devices (
  id text primary key,
  user_id uuid not null references profiles on delete cascade,
  team_id uuid not null references teams on delete cascade,
  name text not null,
  platform text,
  last_seen timestamptz not null default now()
);

-- Each person's own model API key, encrypted by the server before it is stored.
-- Row level security is on with no policies: only the server (service role) can touch it.
create table if not exists user_secrets (
  user_id uuid primary key references profiles on delete cascade,
  api_key_enc text not null,
  updated_at timestamptz not null default now()
);

-- ---- Sessions and chat --------------------------------------------------------------------

create table if not exists sessions (
  id uuid primary key,
  team_id uuid not null references teams on delete cascade,
  owner_id uuid not null references profiles,          -- whose key paid, who may stop it
  goal text not null,
  status text not null default 'running',
  summary text,
  usage jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references sessions on delete cascade,
  author_id uuid not null references profiles,
  target text not null default 'lead',
  text text not null,
  created_at timestamptz not null default now()
);

-- ---- Plan and credits -----------------------------------------------------------------------
-- Someone without their own API key runs sessions on the server's key and pays in credits.
-- Amounts are micro-dollars: 1,000,000 = $1.00. Only the server changes these tables.

alter table sessions add column if not exists billing text;        -- 'own_key' or 'hosted'
alter table sessions add column if not exists cost_micro bigint;   -- what a hosted session was charged

create table if not exists billing_accounts (
  user_id uuid primary key references profiles on delete cascade,
  stripe_customer_id text unique,
  subscription_id text,
  status text not null default 'none',          -- Stripe's subscription status; 'active' unlocks hosted sessions
  period_end timestamptz,
  credits_micro bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Every change to a balance: monthly credits, purchases, and what each session used.
create table if not exists credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles on delete cascade,
  delta_micro bigint not null,
  kind text not null check (kind in ('plan', 'topup', 'usage', 'adjust')),
  session_id uuid references sessions on delete set null,
  event_id text unique,                          -- the Stripe event or usage step; applying it twice does nothing
  note text,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user on credit_ledger (user_id, created_at desc);

-- Changes a balance and writes the ledger line in one step. Returns the new balance.
create or replace function apply_credit(p_user uuid, p_delta bigint, p_kind text, p_session uuid, p_event text, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare bal bigint;
begin
  insert into billing_accounts (user_id) values (p_user) on conflict (user_id) do nothing;
  insert into credit_ledger (user_id, delta_micro, kind, session_id, event_id, note)
    values (p_user, p_delta, p_kind, p_session, p_event, p_note)
    on conflict (event_id) do nothing;
  if not found then   -- this event was already applied
    select credits_micro into bal from billing_accounts where user_id = p_user;
    return bal;
  end if;
  update billing_accounts set credits_micro = credits_micro + p_delta, updated_at = now()
    where user_id = p_user returning credits_micro into bal;
  return bal;
end $$;

-- ---- Memory ---------------------------------------------------------------------------------
-- kind 'note':  a lasting preference or fact. scope 'user' is about one person and visible
--               only to them; scope 'team' is for the whole team.
-- kind 'skill': a how-to written by the lead after a session. Always team scope.
-- author_id is the single person the entry is attributed to: whoever stated the note, or the
-- owner of the session that produced the skill.

create table if not exists memories (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('note', 'skill')),
  scope text not null check (scope in ('user', 'team')),
  team_id uuid not null references teams on delete cascade,
  subject_id uuid references profiles on delete cascade,
  author_id uuid not null references profiles,
  session_id uuid references sessions on delete set null,
  name text,
  description text,
  body text not null,
  revision int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'skill' or (scope = 'team' and name is not null)),
  check (scope <> 'user' or subject_id is not null)
);
create unique index if not exists memories_skill_name on memories (team_id, name) where kind = 'skill';
create index if not exists memories_lookup on memories (team_id, scope, subject_id);

-- Every earlier version of a skill, with who it was attributed to.
create table if not exists memory_revisions (
  id bigint generated always as identity primary key,
  memory_id bigint not null references memories on delete cascade,
  revision int not null,
  author_id uuid not null references profiles,
  description text,
  body text not null,
  created_at timestamptz not null default now()
);

-- ---- Access rules -----------------------------------------------------------------------------

create or replace function is_team_member(t uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where team_id = t and user_id = auth.uid());
$$;

alter table profiles enable row level security;
alter table teams enable row level security;
alter table team_members enable row level security;
alter table devices enable row level security;
alter table user_secrets enable row level security;
alter table sessions enable row level security;
alter table messages enable row level security;
alter table memories enable row level security;
alter table memory_revisions enable row level security;
alter table billing_accounts enable row level security;
alter table credit_ledger enable row level security;

-- You can see your own plan, balance and charges. Nobody else's.
drop policy if exists billing_read on billing_accounts;
create policy billing_read on billing_accounts for select using (user_id = auth.uid());
drop policy if exists ledger_read on credit_ledger;
create policy ledger_read on credit_ledger for select using (user_id = auth.uid());

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (
  id = auth.uid() or exists (
    select 1 from team_members mine join team_members theirs on theirs.team_id = mine.team_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id));
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists teams_read on teams;
create policy teams_read on teams for select using (is_team_member(id));
drop policy if exists members_read on team_members;
create policy members_read on team_members for select using (is_team_member(team_id));
drop policy if exists members_leave on team_members;
create policy members_leave on team_members for delete using (user_id = auth.uid());
drop policy if exists devices_read on devices;
create policy devices_read on devices for select using (is_team_member(team_id));
drop policy if exists sessions_read on sessions;
create policy sessions_read on sessions for select using (is_team_member(team_id));
drop policy if exists messages_read on messages;
create policy messages_read on messages for select using (
  exists (select 1 from sessions s where s.id = messages.session_id and is_team_member(s.team_id)));

-- Team memory is visible to the team. Personal memory is visible only to the person it is about.
drop policy if exists memories_read on memories;
create policy memories_read on memories for select using (
  (scope = 'team' and is_team_member(team_id)) or (scope = 'user' and subject_id = auth.uid()));
-- You may delete what is remembered about you, and team members may prune team memory.
drop policy if exists memories_delete on memories;
create policy memories_delete on memories for delete using (
  (scope = 'user' and subject_id = auth.uid()) or (scope = 'team' and is_team_member(team_id)));
drop policy if exists revisions_read on memory_revisions;
create policy revisions_read on memory_revisions for select using (
  exists (select 1 from memories m where m.id = memory_revisions.memory_id and m.scope = 'team' and is_team_member(m.team_id)));

-- ---- Things the web app calls -------------------------------------------------------------------

create or replace function create_team(team_name text) returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if length(trim(team_name)) = 0 then raise exception 'Give the team a name'; end if;
  insert into teams (name, created_by) values (trim(team_name), auth.uid()) returning id into t;
  insert into team_members (team_id, user_id, role) values (t, auth.uid(), 'owner');
  return t;
end $$;

create or replace function join_team(code text) returns uuid language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into t from teams where invite_code = lower(trim(code));
  if t is null then raise exception 'No team has that invite code'; end if;
  insert into team_members (team_id, user_id) values (t, auth.uid()) on conflict do nothing;
  return t;
end $$;

create or replace function has_api_key() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_secrets where user_id = auth.uid());
$$;

grant execute on function create_team(text), join_team(text), has_api_key(), is_team_member(uuid) to authenticated;

-- ---- Who may reach which table through the API ---------------------------------------------------
-- New Supabase projects no longer expose tables automatically, so every grant is spelled out.
-- Row level security above still decides which rows a signed-in person gets.
-- The server (secret key) does everything; a signed-in person only reads, plus the few changes below.
-- Nobody but the server can touch user_secrets, and visitors who are not signed in get nothing.

grant usage on schema public to authenticated, service_role;
grant all on profiles, teams, team_members, devices, user_secrets, sessions, messages, memories, memory_revisions to service_role;
grant usage, select on all sequences in schema public to service_role;
grant all on billing_accounts, credit_ledger to service_role;
grant execute on all functions in schema public to service_role;
grant select on billing_accounts, credit_ledger to authenticated;
revoke all on billing_accounts, credit_ledger from anon;
-- Postgres lets everyone run a new function unless told otherwise. This one hands out money,
-- so only the server may call it.
revoke execute on function apply_credit(uuid, bigint, text, uuid, text, text) from public, anon, authenticated;
grant execute on function apply_credit(uuid, bigint, text, uuid, text, text) to service_role;

grant select, update on profiles to authenticated;
grant select on teams, devices, sessions, messages, memory_revisions to authenticated;
grant select, delete on team_members, memories to authenticated;
revoke all on profiles, teams, team_members, devices, user_secrets, sessions, messages, memories, memory_revisions from anon;

-- ---- Persistent sessions ----------------------------------------------------------------------
-- A session is a thread of turns, like a chat: each turn is one goal or follow-up and what came of it.
-- It can be continued later from the desktop app; the lead picks up its saved conversation.
-- Safe to re-run.

alter table sessions add column if not exists title text;
alter table sessions add column if not exists turns jsonb not null default '[]';           -- [{goal, ownerId, ownerName, started, ended, status, summary, usage, billing, costMicro}]
alter table sessions add column if not exists participants uuid[] not null default '{}';  -- everyone who took part in any turn

-- What happened, event by event, for viewing a session. Each row says who may see it (audience),
-- and the server filters by it, so there are no client policies: only the server reads this table.
create table if not exists session_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references sessions on delete cascade,
  turn int not null,
  seq int not null,
  at timestamptz not null default now(),
  audience jsonb,            -- null: everyone in the session; {"userId": ...}: that person only
  event jsonb not null
);
create index if not exists session_events_order on session_events (session_id, turn, seq);

-- The lead's conversation, saved after each turn so the session can be continued.
-- It holds tool results from people's computers, so only the server reads it.
create table if not exists session_contexts (
  session_id uuid primary key references sessions on delete cascade,
  messages jsonb not null,
  updated_at timestamptz not null default now()
);

alter table session_events enable row level security;
alter table session_contexts enable row level security;
grant all on session_events, session_contexts to service_role;
revoke all on session_events, session_contexts from anon, authenticated;

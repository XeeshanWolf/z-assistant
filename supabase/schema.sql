-- Z Assistant database. Safe to run again: every statement checks what already exists.
-- __REF__ is replaced with the project ref by the deploy workflow.

-- Tasks and ideas. Each person can only ever see and change their own rows.
create table if not exists public.items (
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id           text not null,
  data         jsonb not null default '{}'::jsonb,
  remind_at    timestamptz,
  notified_for timestamptz,
  deleted      boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists items_user_updated on public.items (user_id, updated_at);
create index if not exists items_due_reminders on public.items (remind_at) where remind_at is not null and deleted = false;

-- Name, daily plan time and time zone.
create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  name       text,
  daily_at   text,
  tz         text,
  last_daily date,
  updated_at timestamptz not null default now()
);

-- Phones that asked for notifications.
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  sub        jsonb not null,
  tz         text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user on public.push_subs (user_id);

-- Server-only keys (notification signing keys). Not reachable from the app.
create schema if not exists private;
create table if not exists private.app_keys (
  name  text primary key,
  value text not null
);
revoke all on schema private from anon, authenticated;

-- updated_at is always set by the server, so phones agree on what changed last.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items for each row execute function public.touch_updated_at();
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before insert or update on public.settings for each row execute function public.touch_updated_at();

-- Signed-out visitors get nothing. Signed-in people may write every column except notified_for,
-- which only the reminder sender sets.
revoke all on public.items, public.settings, public.push_subs from anon;
revoke insert, update on public.items from authenticated;
grant select, delete on public.items to authenticated;
grant insert (user_id, id, data, remind_at, deleted) on public.items to authenticated;
grant update (user_id, id, data, remind_at, deleted) on public.items to authenticated;

alter table public.items enable row level security;
alter table public.settings enable row level security;
alter table public.push_subs enable row level security;

drop policy if exists "own items" on public.items;
create policy "own items" on public.items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own push subs" on public.push_subs;
create policy "own push subs" on public.push_subs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on public.settings, public.push_subs to authenticated;

-- Live updates between phones.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'items') then
    alter publication supabase_realtime add table public.items;
  end if;
end $$;

-- Every minute, ask the reminder sender to send anything that is due.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ begin
  if exists (select 1 from cron.job where jobname = 'z-reminders') then perform cron.unschedule('z-reminders'); end if;
end $$;
select cron.schedule('z-reminders', '* * * * *',
  $cron$ select net.http_post(
    url := 'https://__REF__.supabase.co/functions/v1/remind',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := '{"run":"cron"}'::jsonb,
    timeout_milliseconds := 20000) $cron$);

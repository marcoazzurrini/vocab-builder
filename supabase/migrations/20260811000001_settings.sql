-- Per-user settings: the facts that were constants in SessionScreen.tsx,
-- where changing the daily allowance meant a deploy. One row per user; a user
-- with no row gets the same defaults from the client, mirrored from the
-- column defaults here.
--
-- day_rollover_hour is when the study day begins. Midnight is when learners
-- are awake — a sitting at 23:55 that continues at 00:05 would get a fresh
-- allowance and tomorrow's reviews. Anki draws the same line at 4am.

create table public.settings (
  user_id            uuid primary key default auth.uid()
                     references auth.users (id) on delete cascade,
  lang               text not null default 'fr',
  new_per_day        integer not null default 15
                     check (new_per_day between 0 and 100),
  day_rollover_hour  integer not null default 4
                     check (day_rollover_hour between 0 and 23),
  updated_at         timestamptz not null default now()
);

create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

alter table public.settings enable row level security;

create policy "own settings are readable"
  on public.settings for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "own settings are insertable"
  on public.settings for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "own settings are updatable"
  on public.settings for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete: a settings row only ever wants different values, not absence.
grant select, insert, update on public.settings to authenticated;
grant all on public.settings to service_role;

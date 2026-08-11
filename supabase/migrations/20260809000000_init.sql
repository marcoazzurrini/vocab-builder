-- vocab-builder — initial schema
--
-- Three tables:
--   words     shared content, read-only to users, seeded by script
--   cards     per-user scheduling state — a DERIVED cache, rebuildable from attempts
--   attempts  per-user append-only review history — the source of truth
--
-- The append-only guarantee on `attempts` is enforced by the ABSENCE of UPDATE and
-- DELETE policies: RLS denies by default, so omitting them makes the table
-- insert/select only. It has one door left open, by design -- deleting a card
-- cascades to its attempts. See the RLS section at the bottom.


-- ─────────────────────────────────────────────────────────────────────────────
-- words
-- ─────────────────────────────────────────────────────────────────────────────

create table public.words (
  id          uuid primary key default gen_random_uuid(),

  -- L2: the language being learned. 'fr' now, 'es'/'de' later.
  lang        text not null,
  -- The answer the user types. Stored with correct accents — comparison is
  -- accent-strict, so seed data must be orthographically exact.
  text        text not null,

  -- L1: the prompt side. gloss_lang is here so a future English-speaking
  -- deck doesn't need a migration; it is 'it' for everything we seed.
  gloss       text not null,
  gloss_lang  text not null default 'it',

  -- Disambiguator shown with the gloss when the gloss alone is ambiguous
  -- (Italian "tempo" -> French temps or fois). Without this some cards are
  -- unanswerable by construction.
  hint        text,

  -- Emoji for v1; an asset reference once real images land. Null is expected
  -- for chunks, which rarely map to an image.
  image       text,

  kind        text not null default 'word' check (kind in ('word', 'chunk')),

  -- Position in the frequency list that sourced this row. Drives intro order.
  -- Null for hand-added entries and most chunks.
  freq_rank   integer,

  created_at  timestamptz not null default now(),

  -- Guards against the same entry being seeded twice (merged frequency lists,
  -- a re-run script) without blocking polysemy: livre/libro and livre/libbra are
  -- separate, legitimate cards. Each is graded against its own expected answer,
  -- so a shared answer string is never ambiguous.
  constraint words_lang_text_gloss_unique unique (lang, text, gloss)
);

-- Intro order: next unseen words for a language, by frequency.
create index words_lang_freq_rank_idx on public.words (lang, freq_rank nulls last);
create index words_lang_kind_idx      on public.words (lang, kind);


-- ─────────────────────────────────────────────────────────────────────────────
-- cards
-- ─────────────────────────────────────────────────────────────────────────────

create table public.cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  word_id     uuid not null references public.words (id) on delete cascade,

  -- One word can carry several independently scheduled cards. 'listening'
  -- (hear it -> type it) is roadmap, but the column is here now because
  -- retrofitting it would mean migrating live scheduling state.
  card_type   text not null default 'production'
              check (card_type in ('production', 'listening')),

  -- Whatever ts-fsrs serializes: stability, difficulty, state, reps, lapses,
  -- last_review. A cache — every value here is reproducible by replaying this
  -- card's attempts through ts-fsrs with the current parameters.
  fsrs_state  jsonb not null,

  -- Denormalized out of fsrs_state purely so the due query can use an index.
  due         timestamptz not null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint cards_user_word_type_unique unique (user_id, word_id, card_type)
);

-- The hot query: what is due for me right now.
create index cards_user_due_idx on public.cards (user_id, due);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger cards_set_updated_at
  before update on public.cards
  for each row execute function public.set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- attempts
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Append-only. One row per answered prompt, from rep zero onward — there is no
-- learning phase and review phase, only a card getting older.
--
-- This table is unbackfillable: it is what lets FSRS parameters and learning
-- steps be retrained on real data later, and what lets a corrupted or
-- stale cards.fsrs_state be rebuilt by replay.

create table public.attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  card_id      uuid not null references public.cards (id) on delete cascade,

  -- 'guess'  the pretest before first exposure. Logged, never rated: grading
  --          every guess Again would start every card at identical stability
  --          and destroy the initial-difficulty signal.
  -- 'recall' a real retrieval attempt. The first one is FSRS's rating #1.
  phase        text not null check (phase in ('guess', 'recall')),

  -- Exactly what was typed, including the wrong version. An empty string is a
  -- valid answer — a shrug is a legitimate response to a pretest.
  typed        text not null default '',
  correct      boolean not null,

  -- ts-fsrs Rating: 1 Again, 2 Hard, 3 Good, 4 Easy. Null for guesses.
  rating       smallint check (rating between 1 and 4),

  -- Logged for analysis, never used for grading — too noisy (long words,
  -- distraction, phone keyboards) to carry weight in a scheduling decision.
  latency_ms   integer,

  -- The card's FSRS state immediately BEFORE this attempt was applied.
  -- Required to replay history, and what the optimizer consumes.
  state_before jsonb not null,

  reviewed_at  timestamptz not null default now(),

  -- Encodes the grading model in the schema rather than trusting the client:
  -- guesses are never rated, recalls always are.
  constraint attempts_guess_unrated check (
    (phase = 'guess'  and rating is null) or
    (phase = 'recall' and rating is not null)
  ),

  -- A wrong answer is Again, with no exceptions — including a wrong accent.
  constraint attempts_wrong_is_again check (
    correct or phase = 'guess' or rating = 1
  )
);

-- Replay a single card's history, oldest first.
create index attempts_card_reviewed_idx on public.attempts (card_id, reviewed_at);
-- Stats and full-history export for retraining.
create index attempts_user_reviewed_idx on public.attempts (user_id, reviewed_at);


-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.words    enable row level security;
alter table public.cards    enable row level security;
alter table public.attempts enable row level security;

-- words: shared content, readable by any signed-in user, writable by nobody.
-- Seeding runs as the table owner (migration / service role), which bypasses RLS.
create policy "words are readable by authenticated users"
  on public.words for select
  to authenticated
  using (true);

-- cards: fully owned by the user. Deletable on purpose — a card is a derived
-- cache, so dropping and rebuilding one from attempts is a legitimate repair.
create policy "own cards are readable"
  on public.cards for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "own cards are insertable"
  on public.cards for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "own cards are updatable"
  on public.cards for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own cards are deletable"
  on public.cards for delete to authenticated
  using ((select auth.uid()) = user_id);

-- attempts: insert and select only.
--
-- There is deliberately no UPDATE or DELETE policy, and no UPDATE or DELETE
-- grant below, so no row here can be edited or removed by name.
--
-- That is not the same as history being immutable, and the difference is worth
-- being exact about. `attempts.card_id` cascades, and a user may delete their
-- own cards -- so deleting a card takes its attempts with it, through the
-- foreign key rather than through any policy. The cascade is what makes "drop a
-- corrupt card and rebuild it from history" possible, and the same door lets
-- that history be dropped. Erasable in bulk, then, but not editable: what
-- remains cannot have been altered. See Known gaps in the README.
create policy "own attempts are readable"
  on public.attempts for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "own attempts are insertable"
  on public.attempts for insert to authenticated
  with check ((select auth.uid()) = user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- Table privileges
-- ─────────────────────────────────────────────────────────────────────────────
--
-- RLS and grants are two independent gates: a policy *permits* a row, a grant
-- *enables* the operation, and every request needs both. New tables in `public`
-- get no DML grants for anon/authenticated by default, so without this block
-- every query from the browser fails with "permission denied" regardless of how
-- correct the policies are.
--
-- Nothing is granted to `anon`: every route into this data requires a signed-in
-- user, so an unauthenticated request has no reachable surface at all.

grant select                         on public.words    to authenticated;
grant select, insert, update, delete on public.cards    to authenticated;

-- No update, no delete. The missing grant is the real enforcement of
-- append-only; the missing policy alone would be easy to undo by accident.
grant select, insert                 on public.attempts to authenticated;

-- service_role bypasses RLS and is what seeding and maintenance tooling uses.
grant all on public.words, public.cards, public.attempts to service_role;

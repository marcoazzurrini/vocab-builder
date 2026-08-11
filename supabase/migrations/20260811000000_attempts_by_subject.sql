-- Re-key attempts by their subject, not by the cache that summarises them.
--
-- `attempts` is the append-only source of truth, and it held a foreign key
-- into `cards` — a derived cache. That one arrow was the root of four separate
-- problems:
--
--   * the card row had to exist before the guess could be written, which is
--     what created the "unseen" limbo state (a row with no attempts) and the
--     write-ordering requirement between the two inserts;
--   * the card row was named by a random uuid, so two devices introducing the
--     same word minted different names for the same card and the second write
--     was rejected instead of merged;
--   * deleting a card cascaded into attempts, so the one unbackfillable table
--     was erasable in bulk through a foreign key;
--   * whether a word was "guessed" had to be re-derived by joining the two
--     tables, and the derivations disagreeing is where half the shipped bugs
--     came from.
--
-- An attempt is about (user, word, card_type). Keyed that way:
--
--   * nothing at all is written at introduction except the guess attempt — a
--     card row is born at FSRS's first rating, so "unseen" is not a state that
--     needs labelling, it is a state that cannot exist;
--   * cards need no uuid: the natural key IS the identity, so both devices
--     write the same row and the later write is an ordinary update;
--   * deleting a card no longer touches history — drop-and-rebuild-from-
--     attempts still works, and the history it rebuilds from cannot be lost;
--   * "one guess per word, ever" stops being an application promise and
--     becomes a partial unique index.

-- ─────────────────────────────────────────────────────────────────────────────
-- attempts learn their subject
-- ─────────────────────────────────────────────────────────────────────────────

-- `restrict`, not cascade: words are the permanent catalogue, and a word with
-- history may not be deleted out from under it.
alter table public.attempts
  add column word_id   uuid references public.words (id) on delete restrict,
  add column card_type text check (card_type in ('production', 'listening'));

update public.attempts a
   set word_id   = c.word_id,
       card_type = c.card_type
  from public.cards c
 where a.card_id = c.id;

alter table public.attempts
  alter column word_id   set not null,
  alter column card_type set not null,
  alter column card_type set default 'production';

-- Dropping the column drops attempts_card_reviewed_idx and the cascade with it.
alter table public.attempts drop column card_id;

-- Replay a single card's history, oldest first.
create index attempts_replay_idx
  on public.attempts (user_id, word_id, card_type, reviewed_at);

-- One pretest per word, ever. The invariant the session module promises,
-- enforced where a racing second device would otherwise break it: the loser's
-- duplicate guess is rejected here and the client drops it as benign.
create unique index attempts_one_guess_idx
  on public.attempts (user_id, word_id, card_type)
  where phase = 'guess';

-- Tightened: the old form let a *correct* answer be rated Again, which the
-- app never writes and the tests already treated as a contradiction. A recall's
-- rating now agrees with its correctness in both directions.
alter table public.attempts drop constraint attempts_wrong_is_again;
alter table public.attempts add constraint attempts_wrong_is_again check (
  phase = 'guess' or correct = (rating <> 1)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- cards become a pure cache
-- ─────────────────────────────────────────────────────────────────────────────

-- Rows the old model wrote at introduction but FSRS never rated are not
-- scheduling state. Their guess attempts (already re-keyed above, and now
-- beyond the reach of any cascade) carry everything the new model needs to
-- rebuild them as "awaiting"; a row that was never even guessed was nothing
-- but the old foreign-key requirement.
delete from public.cards where (fsrs_state->>'reps')::int = 0;

-- The uuid was only ever a second name for what (user_id, word_id, card_type)
-- already named — and two names for one thing is how the collision happened.
-- `due` was a copy of fsrs_state->>'due' for an index no query used.
alter table public.cards
  drop constraint cards_user_word_type_unique,
  drop column id,
  drop column due;

alter table public.cards add primary key (user_id, word_id, card_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- the awaiting words, queryable
-- ─────────────────────────────────────────────────────────────────────────────

-- A guess with no card row is a word introduced but never rated — the app
-- closed between the exposure and the first recall. "No matching card" is an
-- anti-join PostgREST cannot express, so it lives here. security_invoker makes
-- the underlying RLS apply: each user sees only their own guesses.
create view public.awaiting_guesses
  with (security_invoker = on) as
  select a.user_id, a.word_id, a.card_type, a.reviewed_at, w.lang
    from public.attempts a
    join public.words w on w.id = a.word_id
   where a.phase = 'guess'
     and not exists (
       select 1 from public.cards c
        where c.user_id = a.user_id
          and c.word_id = a.word_id
          and c.card_type = a.card_type
     );

grant select on public.awaiting_guesses to authenticated;

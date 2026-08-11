\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages to notice;

-- ── cleanup ─────────────────────────────────────────────────────────────────
-- Makes the suite re-runnable without `supabase db reset`. A test you have to
-- reset the database to run twice is a test you stop running.
-- Deleting the user cascades to its cards and attempts; the words can only be
-- deleted after that, because attempts restrict word deletion by design.
delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
delete from public.words where lang = 'fr' and text in ('fenêtre', 'tour');

-- ── fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, aud, role)
values ('11111111-1111-1111-1111-111111111111', 'marco@test.local', 'authenticated', 'authenticated');

insert into public.words (id, lang, text, gloss, image, kind, freq_rank)
values ('22222222-2222-2222-2222-222222222222', 'fr', 'fenêtre', 'finestra', '🪟', 'word', 412);

insert into public.cards (user_id, word_id, fsrs_state)
values ('11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '{"stability": 0, "difficulty": 0, "state": 0}'::jsonb);

-- ── constraint behaviour ────────────────────────────────────────────────────
do $$
declare
  u uuid := '11111111-1111-1111-1111-111111111111';
  w uuid := '22222222-2222-2222-2222-222222222222';
  n int;
begin
  -- 1. a rated guess must be rejected
  begin
    insert into public.attempts (user_id, word_id, phase, typed, correct, rating, state_before)
    values (u, w, 'guess', 'fenetre', false, 3, '{}'::jsonb);
    raise notice 'FAIL 1  rated guess was accepted';
  exception when check_violation then
    raise notice 'PASS 1  rated guess rejected';
  end;

  -- 2. an unrated recall must be rejected
  begin
    insert into public.attempts (user_id, word_id, phase, typed, correct, rating, state_before)
    values (u, w, 'recall', 'fenêtre', true, null, '{}'::jsonb);
    raise notice 'FAIL 2  unrated recall was accepted';
  exception when check_violation then
    raise notice 'PASS 2  unrated recall rejected';
  end;

  -- 3. a wrong answer graded anything but Again must be rejected
  begin
    insert into public.attempts (user_id, word_id, phase, typed, correct, rating, state_before)
    values (u, w, 'recall', 'fenetre', false, 3, '{}'::jsonb);
    raise notice 'FAIL 3  wrong answer graded Good was accepted';
  exception when check_violation then
    raise notice 'PASS 3  wrong answer graded Good rejected';
  end;

  -- 4. a correct answer graded Again must be rejected: the rating and the
  --    typed answer agree in both directions
  begin
    insert into public.attempts (user_id, word_id, phase, typed, correct, rating, state_before)
    values (u, w, 'recall', 'fenêtre', true, 1, '{}'::jsonb);
    raise notice 'FAIL 4  correct answer graded Again was accepted';
  exception when check_violation then
    raise notice 'PASS 4  correct answer graded Again rejected';
  end;

  -- 5. wrong answer graded Again is fine
  insert into public.attempts (user_id, word_id, phase, typed, correct, rating, state_before)
  values (u, w, 'recall', 'fenetre', false, 1, '{}'::jsonb);
  raise notice 'PASS 5  wrong answer graded Again accepted';

  -- 6. unrated guess is fine, including an empty answer ("no idea")
  insert into public.attempts (user_id, word_id, phase, typed, correct, state_before)
  values (u, w, 'guess', '', false, '{}'::jsonb);
  raise notice 'PASS 6  empty unrated guess accepted';

  -- 7. a second guess for the same word must be rejected: one pretest per
  --    word, ever, is a schema-level promise
  begin
    insert into public.attempts (user_id, word_id, phase, typed, correct, state_before)
    values (u, w, 'guess', 'finestra?', false, '{}'::jsonb);
    raise notice 'FAIL 7  second guess for the same word was accepted';
  exception when unique_violation then
    raise notice 'PASS 7  second guess for the same word rejected';
  end;

  -- 8. correct answer graded Easy is fine
  insert into public.attempts (user_id, word_id, phase, typed, correct, rating, latency_ms, state_before)
  values (u, w, 'recall', 'fenêtre', true, 4, 2300, '{}'::jsonb);
  raise notice 'PASS 8  correct answer graded Easy accepted';

  -- 9. polysemy allowed: same lang+text, different gloss.
  --    Uses `tour`, which the starter deck does not contain — fixtures must not
  --    collide with seeded rows or this reports a false failure.
  begin
    insert into public.words (lang, text, gloss, kind) values ('fr', 'tour', 'torre', 'word');
    insert into public.words (lang, text, gloss, kind) values ('fr', 'tour', 'giro', 'word');
    raise notice 'PASS 9  polysemy (tour/torre + tour/giro) accepted';
  exception when unique_violation then
    raise notice 'FAIL 9  polysemy rejected';
  end;

  -- 10. true duplicate rejected
  begin
    insert into public.words (lang, text, gloss, kind) values ('fr', 'tour', 'torre', 'word');
    raise notice 'FAIL 10 duplicate word accepted';
  exception when unique_violation then
    raise notice 'PASS 10 duplicate word rejected';
  end;

  -- 11. duplicate card for same (user, word, type) rejected — it is the
  --     primary key now, there is no other name a card could hide under
  begin
    insert into public.cards (user_id, word_id, fsrs_state)
    values (u, w, '{}'::jsonb);
    raise notice 'FAIL 11 duplicate card accepted';
  exception when unique_violation then
    raise notice 'PASS 11 duplicate card rejected';
  end;

  -- 12. same word, different card_type, is a distinct card
  insert into public.cards (user_id, word_id, card_type, fsrs_state)
  values (u, w, 'listening', '{}'::jsonb);
  raise notice 'PASS 12 listening card coexists with production card';

  -- 13. deleting a card leaves its history untouched: the cache is
  --     disposable, the attempts it was derived from are not
  select count(*) into n from public.attempts where user_id = u and word_id = w;
  delete from public.cards where user_id = u and word_id = w and card_type = 'production';
  if (select count(*) from public.attempts where user_id = u and word_id = w) = n then
    raise notice 'PASS 13 card deletion left % attempts in place', n;
  else
    raise notice 'FAIL 13 card deletion took attempts with it';
  end if;

  -- 14. a word with history cannot be deleted out from under it
  begin
    delete from public.words where id = w;
    raise notice 'FAIL 14 word with history was deleted';
  exception when foreign_key_violation then
    raise notice 'PASS 14 word with history is protected';
  end;

  -- 15. the awaiting view shows the guessed-but-uncarded word
  select count(*) into n from public.awaiting_guesses
   where user_id = u and word_id = w and card_type = 'production';
  if n = 1 then
    raise notice 'PASS 15 awaiting view shows the rowless guess';
  else
    raise notice 'FAIL 15 awaiting view returned % rows', n;
  end if;

  -- restore the production card for the trigger and RLS sections below
  insert into public.cards (user_id, word_id, fsrs_state)
  values (u, w, '{"stability": 0, "difficulty": 0, "state": 0}'::jsonb);
end $$;

-- ── updated_at trigger ──────────────────────────────────────────────────────
do $$
declare before_ts timestamptz; after_ts timestamptz;
begin
  select updated_at into before_ts from public.cards
   where user_id = '11111111-1111-1111-1111-111111111111'
     and word_id = '22222222-2222-2222-2222-222222222222'
     and card_type = 'production';
  perform pg_sleep(0.05);
  update public.cards set fsrs_state = fsrs_state || '{"reps": 1}'::jsonb
   where user_id = '11111111-1111-1111-1111-111111111111'
     and word_id = '22222222-2222-2222-2222-222222222222'
     and card_type = 'production';
  select updated_at into after_ts from public.cards
   where user_id = '11111111-1111-1111-1111-111111111111'
     and word_id = '22222222-2222-2222-2222-222222222222'
     and card_type = 'production';
  if after_ts > before_ts then
    raise notice 'PASS 16 updated_at trigger fired';
  else
    raise notice 'FAIL 16 updated_at did not change';
  end if;
end $$;

-- ── RLS as the authenticated user ───────────────────────────────────────────
begin;
  set local role authenticated;
  set local "request.jwt.claims" =
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  do $$
  declare n int;
  begin
    -- 17. can read own attempts
    select count(*) into n from public.attempts;
    raise notice 'PASS 17 own attempts readable (% rows)', n;

    -- 18. cannot update history
    begin
      update public.attempts set typed = 'tampered';
      raise notice 'FAIL 18 attempts UPDATE succeeded';
    exception
      when insufficient_privilege then raise notice 'PASS 18 attempts UPDATE denied';
      when others then raise notice 'PASS 18 attempts UPDATE blocked (%)', sqlstate;
    end;

    -- 19. cannot delete history
    begin
      delete from public.attempts;
      raise notice 'FAIL 19 attempts DELETE succeeded';
    exception
      when insufficient_privilege then raise notice 'PASS 19 attempts DELETE denied';
      when others then raise notice 'PASS 19 attempts DELETE blocked (%)', sqlstate;
    end;

    -- 20. can read shared content
    select count(*) into n from public.words;
    raise notice 'PASS 20 words readable (% rows)', n;

    -- 21. cannot write shared content
    begin
      insert into public.words (lang, text, gloss) values ('fr', 'pirate', 'pirata');
      raise notice 'FAIL 21 words INSERT succeeded';
    exception
      when insufficient_privilege then raise notice 'PASS 21 words INSERT denied';
      when others then raise notice 'PASS 21 words INSERT blocked (%)', sqlstate;
    end;

    -- 22. cannot insert an attempt attributed to someone else
    begin
      insert into public.attempts (user_id, word_id, phase, typed, correct, rating, state_before)
      values ('99999999-9999-9999-9999-999999999999',
              '22222222-2222-2222-2222-222222222222',
              'recall', 'x', true, 3, '{}'::jsonb);
      raise notice 'FAIL 22 attempt for another user accepted';
    exception
      when others then raise notice 'PASS 22 attempt for another user blocked (%)', sqlstate;
    end;
  end $$;
rollback;

-- ── RLS as a different signed-in user ───────────────────────────────────────
begin;
  set local role authenticated;
  set local "request.jwt.claims" =
    '{"sub":"88888888-8888-8888-8888-888888888888","role":"authenticated"}';

  do $$
  declare n int;
  begin
    select count(*) into n from public.attempts;
    if n = 0 then raise notice 'PASS 23 other user sees no attempts';
    else raise notice 'FAIL 23 other user sees % attempts', n; end if;

    select count(*) into n from public.cards;
    if n = 0 then raise notice 'PASS 24 other user sees no cards';
    else raise notice 'FAIL 24 other user sees % cards', n; end if;

    -- The view runs with the caller's rights, so it is empty too.
    select count(*) into n from public.awaiting_guesses;
    if n = 0 then raise notice 'PASS 25 other user sees no awaiting guesses';
    else raise notice 'FAIL 25 other user sees % awaiting guesses', n; end if;
  end $$;
rollback;

-- ── anon is locked out entirely ─────────────────────────────────────────────
begin;
  set local role anon;
  do $$
  declare n int;
  begin
    select count(*) into n from public.words;
    if n = 0 then raise notice 'PASS 26 anon sees no words';
    else raise notice 'FAIL 26 anon sees % words', n; end if;
  exception when insufficient_privilege then
    raise notice 'PASS 26 anon denied on words';
  end $$;
rollback;

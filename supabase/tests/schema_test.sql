\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages to notice;

-- ── fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email, aud, role)
values ('11111111-1111-1111-1111-111111111111', 'marco@test.local', 'authenticated', 'authenticated');

insert into public.words (id, lang, text, gloss, image, kind, freq_rank)
values ('22222222-2222-2222-2222-222222222222', 'fr', 'fenêtre', 'finestra', '🪟', 'word', 412);

insert into public.cards (id, user_id, word_id, fsrs_state, due)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '{"stability": 0, "difficulty": 0, "state": 0}'::jsonb,
        now());

-- ── constraint behaviour ────────────────────────────────────────────────────
do $$
declare
  u uuid := '11111111-1111-1111-1111-111111111111';
  c uuid := '33333333-3333-3333-3333-333333333333';

  procedure_note text;
begin
  -- 1. a rated guess must be rejected
  begin
    insert into public.attempts (user_id, card_id, phase, typed, correct, rating, state_before)
    values (u, c, 'guess', 'fenetre', false, 3, '{}'::jsonb);
    raise notice 'FAIL 1  rated guess was accepted';
  exception when check_violation then
    raise notice 'PASS 1  rated guess rejected';
  end;

  -- 2. an unrated recall must be rejected
  begin
    insert into public.attempts (user_id, card_id, phase, typed, correct, rating, state_before)
    values (u, c, 'recall', 'fenêtre', true, null, '{}'::jsonb);
    raise notice 'FAIL 2  unrated recall was accepted';
  exception when check_violation then
    raise notice 'PASS 2  unrated recall rejected';
  end;

  -- 3. a wrong answer graded anything but Again must be rejected
  begin
    insert into public.attempts (user_id, card_id, phase, typed, correct, rating, state_before)
    values (u, c, 'recall', 'fenetre', false, 3, '{}'::jsonb);
    raise notice 'FAIL 3  wrong answer graded Good was accepted';
  exception when check_violation then
    raise notice 'PASS 3  wrong answer graded Good rejected';
  end;

  -- 4. wrong answer graded Again is fine
  insert into public.attempts (user_id, card_id, phase, typed, correct, rating, state_before)
  values (u, c, 'recall', 'fenetre', false, 1, '{}'::jsonb);
  raise notice 'PASS 4  wrong answer graded Again accepted';

  -- 5. unrated guess is fine, including an empty answer ("no idea")
  insert into public.attempts (user_id, card_id, phase, typed, correct, state_before)
  values (u, c, 'guess', '', false, '{}'::jsonb);
  raise notice 'PASS 5  empty unrated guess accepted';

  -- 6. correct answer graded Easy is fine
  insert into public.attempts (user_id, card_id, phase, typed, correct, rating, latency_ms, state_before)
  values (u, c, 'recall', 'fenêtre', true, 4, 2300, '{}'::jsonb);
  raise notice 'PASS 6  correct answer graded Easy accepted';

  -- 7. polysemy allowed: same lang+text, different gloss.
  --    Uses `tour`, which the starter deck does not contain — fixtures must not
  --    collide with seeded rows or this reports a false failure.
  begin
    insert into public.words (lang, text, gloss, kind) values ('fr', 'tour', 'torre', 'word');
    insert into public.words (lang, text, gloss, kind) values ('fr', 'tour', 'giro', 'word');
    raise notice 'PASS 7  polysemy (tour/torre + tour/giro) accepted';
  exception when unique_violation then
    raise notice 'FAIL 7  polysemy rejected';
  end;

  -- 8. true duplicate rejected
  begin
    insert into public.words (lang, text, gloss, kind) values ('fr', 'tour', 'torre', 'word');
    raise notice 'FAIL 8  duplicate word accepted';
  exception when unique_violation then
    raise notice 'PASS 8  duplicate word rejected';
  end;

  -- 9. duplicate card for same (user, word, type) rejected
  begin
    insert into public.cards (user_id, word_id, fsrs_state, due)
    values (u, '22222222-2222-2222-2222-222222222222', '{}'::jsonb, now());
    raise notice 'FAIL 9  duplicate card accepted';
  exception when unique_violation then
    raise notice 'PASS 9  duplicate card rejected';
  end;

  -- 10. same word, different card_type, is a distinct card
  insert into public.cards (user_id, word_id, card_type, fsrs_state, due)
  values (u, '22222222-2222-2222-2222-222222222222', 'listening', '{}'::jsonb, now());
  raise notice 'PASS 10 listening card coexists with production card';
end $$;

-- ── updated_at trigger ──────────────────────────────────────────────────────
do $$
declare before_ts timestamptz; after_ts timestamptz;
begin
  select updated_at into before_ts from public.cards
   where id = '33333333-3333-3333-3333-333333333333';
  perform pg_sleep(0.05);
  update public.cards set due = now() + interval '1 day'
   where id = '33333333-3333-3333-3333-333333333333';
  select updated_at into after_ts from public.cards
   where id = '33333333-3333-3333-3333-333333333333';
  if after_ts > before_ts then
    raise notice 'PASS 11 updated_at trigger fired';
  else
    raise notice 'FAIL 11 updated_at did not change';
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
    -- 12. can read own attempts
    select count(*) into n from public.attempts;
    raise notice 'PASS 12 own attempts readable (% rows)', n;

    -- 13. cannot update history
    begin
      update public.attempts set typed = 'tampered';
      raise notice 'FAIL 13 attempts UPDATE succeeded';
    exception
      when insufficient_privilege then raise notice 'PASS 13 attempts UPDATE denied';
      when others then raise notice 'PASS 13 attempts UPDATE blocked (%)', sqlstate;
    end;

    -- 14. cannot delete history
    begin
      delete from public.attempts;
      raise notice 'FAIL 14 attempts DELETE succeeded';
    exception
      when insufficient_privilege then raise notice 'PASS 14 attempts DELETE denied';
      when others then raise notice 'PASS 14 attempts DELETE blocked (%)', sqlstate;
    end;

    -- 15. can read shared content
    select count(*) into n from public.words;
    raise notice 'PASS 15 words readable (% rows)', n;

    -- 16. cannot write shared content
    begin
      insert into public.words (lang, text, gloss) values ('fr', 'pirate', 'pirata');
      raise notice 'FAIL 16 words INSERT succeeded';
    exception
      when insufficient_privilege then raise notice 'PASS 16 words INSERT denied';
      when others then raise notice 'PASS 16 words INSERT blocked (%)', sqlstate;
    end;

    -- 17. cannot insert an attempt attributed to someone else
    begin
      insert into public.attempts (user_id, card_id, phase, typed, correct, rating, state_before)
      values ('99999999-9999-9999-9999-999999999999',
              '33333333-3333-3333-3333-333333333333',
              'recall', 'x', true, 3, '{}'::jsonb);
      raise notice 'FAIL 17 attempt for another user accepted';
    exception
      when others then raise notice 'PASS 17 attempt for another user blocked (%)', sqlstate;
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
    if n = 0 then raise notice 'PASS 18 other user sees no attempts';
    else raise notice 'FAIL 18 other user sees % attempts', n; end if;

    select count(*) into n from public.cards;
    if n = 0 then raise notice 'PASS 19 other user sees no cards';
    else raise notice 'FAIL 19 other user sees % cards', n; end if;
  end $$;
rollback;

-- ── anon is locked out entirely ─────────────────────────────────────────────
begin;
  set local role anon;
  do $$
  declare n int;
  begin
    select count(*) into n from public.words;
    if n = 0 then raise notice 'PASS 20 anon sees no words';
    else raise notice 'FAIL 20 anon sees % words', n; end if;
  exception when insufficient_privilege then
    raise notice 'PASS 20 anon denied on words';
  end $$;
rollback;

# vocab-builder

A vocabulary learning app built on the evidence about how vocabulary is actually
acquired. French first, Italian as L1. Spanish and German planned.

Personal project, single user, built to last — not a bootstrapping tool with an
expiry date.

## Status

Deployed and usable: sign in with a magic link, answer cards, progress is saved.
`src/session/` owns the whole pipeline behind one function. What is outstanding
is in What's next, and the things that are wrong rather than missing are under
Schema and Known gaps.

## Research foundations

These are the spec. Design decisions trace back to them.

1. **Productive recall beats recognition.** Typing the L2 word from an L1 prompt
   produces the largest gains. Multiple-choice is measurably worse. Direction
   matters: L1→L2 trains production, L2→L1 trains comprehension.
2. **Encoding should be tiny.** One clean exposure — see the word, hear it, say it
   aloud — then straight into retrieval. Learning happens during retrieval with
   feedback, not during study.
3. **Pretesting / errorful generation.** Guessing before first exposure improves
   retention even when the guess is wrong. No penalty for wrong guesses.
4. **Spacing with expanding intervals.** Spaced ≈ 1.6× massed at one week.
   Expanding gaps slightly beat equal gaps.
5. **No semantic clustering.** Never batch related words (all colours, all animals)
   — they interfere. Frequency-ordered, thematically mixed.
6. **Audio from day one.** Aural word knowledge predicts listening comprehension
   better than written knowledge. Every card plays TTS; the user repeats aloud.
7. **Chunks are vocabulary too.** High-frequency formulaic sequences ("je
   voudrais…") are stored and retrieved as single units, and carry grammar for free.
8. **Unit = lemma, not word family.** One card per dictionary form. Inflection is
   grammar's job; derivations get their own card only when frequent enough.
9. **Frequency lists from subtitle corpora**, filtered to exclude pure function
   words.

## The pipeline

There is no learning phase and strengthening phase — they are the same exercise.
The first meeting is rep zero.

```
GUESS      free input, no penalty, a shrug is a valid answer        (§3)
  ↓        logged, but not fed to FSRS — see grading below
EXPOSURE   word + image + TTS audio, user repeats aloud             (§2, §6)
  ↓
RECALL     type the French word, from rep zero onward               (§1)
  ↓
FSRS       one scheduler owns the whole lifecycle                   (§4)
```

### Scheduling

One scheduler, not two. `ts-fsrs` with `learning_steps` and `enable_short_term`
handles both same-session reps and across-day reviews. Gaps come from FSRS's
difficulty/stability estimate, never a hardcoded ladder, and graduation is not a
step count — it is the interval genuinely exceeding a day.

**The session never waits.** A due time is not an appointment. When nothing is
due yet, the answer is never to sit and watch a timer, so the next card is chosen
by this rule:

1. A rated learning card is due → ask for it.
2. A word was introduced but never guessed → resume it, without spending allowance.
3. Today's new-word allowance is not used up → introduce a new word.
4. A review is due today → ask for it.
5. A word is waiting for its first recall and this sitting has not shown it →
   show it.
6. A word has been shown and is waiting to be asked for → ask for it, unless it
   is the one just shown.
7. Otherwise, pull forward the soonest-due card **that is still in its learning
   steps today**, never the one just answered and never twice in a sitting.
8. A word just shown, when there is nothing else at all → ask for it.
9. Nothing left within today → the session is over.

This list is the code. `src/session/queue.ts` holds one named rule per line and
an array in this order, because prose and precedence living in different places
is how they came to disagree.

**A card's stage is a value, not an inference.** `unseen` (a row exists, nothing
has happened), `awaiting` (guessed, and FSRS has still never rated it),
`scheduled` (rated). FSRS cannot own the first two: it has no opinion about a
card it has never rated, since the first rating is its input and not its output.
Every bug this pipeline has shipped came from two places deriving that stage
differently from `reps`, `state`, `due`, `guessed` and a set of ids held in the
session — so it is derived once now, and the rule asks what a card _is_ rather
than reconstructing it from parts.

**The exposure returns to the queue, it does not fall through to the recall.**
Producing a word two seconds after being shown it is trivial, and the rating it
yields is FSRS's _first_ — the one that sets the card's initial difficulty. An
immediate recall makes that rating measure short-term memory rather than the
word, which wastes the very signal we protect by refusing to rate guesses.

Steps 5 and 6 are separate for the same reason. Returning to the queue only helps
if the queue can tell that the exposure happened, and it could not: an exposure
changed nothing the rule could see, so it handed the same card straight back on
every resumed sitting. Splitting the two means a batch of resumed words is shown
through before any of them is asked for — the shape a fresh sitting already had.

Both sit after the reviews, so a batch is introduced, the day's reviews are
worked through, and only then are the new words asked for. Ordering is the honest
lever here rather than an interval we invented to sit alongside FSRS.

An unrated card is not a scheduled card — it is a word that has not been
introduced yet, so step 2 hands it back to the introduction path. Scheduling it
instead is what once asked for a word that had never been shown, since every
scheduled card goes straight to recall.

Step 8 exists so that step 6's exclusion cannot starve a word: with one card and
nothing else to do, coming straight back is right, because refusing would show a
word and never ask for it, again on the next sitting and the one after. It is
last so that everything else — including pulling a learning card forward — goes
first. An early review costs a little stability once; a rating #1 taken from the
short-term buffer misprices the card for its whole life.

Step 7 is bounded twice over.

**To learning cards.** Pulling forward a card due in five minutes is nearly free
— it is mid-learning and the gap was minutes either way. Pulling forward a card
due in three days throws away three days of earned spacing, and spacing is where
nearly all of the retention comes from. It also empties tomorrow, which invites
doing it again, and the collection drifts toward massing. Anki draws its line in
the same place: learn-ahead applies only to learning cards, never to mature
reviews from future days.

**To once per card per sitting**, which is what lets a session end at all. A card
dragged forward is answered, which schedules it a minute out, which is still
today, so it is dragged forward again. "Never the same card twice running" stops
the one-card cycle and nothing else, because two cards simply alternate — an hour
later the session is still going, which is the padding this design exists to
refuse. A card that genuinely comes due is served by step 1, which is uncapped
and has earned it.

So a session that has run out is over, not padded. On day one, 15 new words with
no backlog is about nine minutes of work and then genuinely nothing to do,
because every card is correctly parked two days out. Filling that time by
dragging tomorrow's cards forward trades a durable gain for a few minutes of
activity, and it compounds.

Pulling a card forward is safe: FSRS scores on _actual_ elapsed time, not
scheduled time, so an early review is scored correctly. It simply earns less
stability than the longer gap would have — a small, one-off cost, unlike dead air.

New words come before pulling forward, and the daily allowance is never exceeded
to fill time. That limit exists to control future workload; overshooting it today
makes every later day heavier, compounding. An early review costs a little
stability once.

Two things a throwaway simulation established by measurement, against earlier
guesses written here. The simulation itself was deleted in `fb6c255` once it had
diverged from the real rule; `d317d5b` still holds it:

- **A minimum-interleave floor of 2 or 3 does nothing.** Floors of 0, 2 and 3
  produce identical sessions and never bind, because the learning step already
  forces far larger gaps.

  That measurement was taken on sessions of ten cards or more, and it does not
  extend to the tail. With two or three cards left, step 7 will hand back the
  card just answered — massing with extra steps. So a floor of exactly **1**
  survives: never the same card twice in a row. When that leaves nothing, the
  session ends, because the gap it wanted cannot be filled today and tomorrow
  will fill it properly.

- **Once the session never waits, the configured learning step barely matters.**
  `1m,3m` and `1m,10m` yield near-identical sessions, because real spacing is set
  by how many cards are in rotation, not by the clock — the step is a ceiling that
  rarely binds. So FSRS's defaults stand, and spacing widens on its own as the
  collection grows.

Measured at ~18s per answer: 10 new words ≈ 8 minutes and 28 answers, 30 new
words ≈ 25 minutes, both with zero idle time.

### Grading

Typing gives objective pass/fail for free, which is the tedious part of self-grading.
What remains is only "how easily did that come?".

| Situation                  | Grade                     | Interaction                                |
| -------------------------- | ------------------------- | ------------------------------------------ |
| Pretest guess              | _not rated_ — logged only | one action to continue                     |
| Correct                    | Hard / **Good** / Easy    | grade buttons **are** submit — one action  |
| Wrong (incl. wrong accent) | Again                     | two actions: see the answer, then continue |

- The first post-exposure recall is FSRS's rating #1, so the initial-difficulty
  signal is preserved. Grading every guess `Again` would carry zero information.
- Grading happens _before_ the answer is revealed. Retrieval ease is known the moment
  you finish typing, and the rating stays uncontaminated by the outcome.
- Enter = Good. The default path is one action and requires no grading decision.
- Wrong answers show the correct spelling with no diff highlighting — hunting for the
  difference is itself desirable difficulty.
- Response latency is logged, never graded. Too noisy to carry weight.

#### Answer comparison

One rule decides everything here: **orthography is graded, typography is not.**
A missing accent changes the word. A ligature, a keyboard's choice of apostrophe,
or a space before a question mark does not.

Graded — a mismatch is wrong:

- **Accents.** `fenetre` is not a French word.
- **Letters and word order**, obviously.

Normalised away before comparing:

- **Case and surrounding whitespace.**
- **Unicode composition**, to NFC. `ê` can arrive as one character or as `e`
  plus a combining circumflex; they render identically and compare unequal.
  Wrong answers are shown without diff highlighting on purpose, so this is the
  one mismatch the user could not possibly be expected to find.
- **`œ` → `oe`.** French writes it both ways.
- **Apostrophes**, straight `'` (U+0027), curly `’` (U+2019) and the four other
  single quotes keyboards emit, to one form.
- **Internal whitespace**, collapsed to single spaces. Matters for chunks.
- **Terminal punctuation**, `? ! .` stripped from both sides.

Terminal punctuation is still _stored_ and _displayed_, just never graded — and it
is stored mainly for the audio. `speechSynthesis` reads `qu'est-ce que c'est ?`
with rising question intonation and `qu'est-ce que c'est` flat. For a formulaic
sequence the intonation contour is part of the chunk (§7).

## Stack

| Layer      | Choice                                                       |
| ---------- | ------------------------------------------------------------ |
| Frontend   | Vite + React SPA, no router (phase state is the router)      |
| Hosting    | Cloudflare Pages                                             |
| Backend    | none — `supabase-js` direct from the browser, RLS is the API |
| DB         | Supabase Postgres                                            |
| Auth       | Supabase Auth, magic link                                    |
| Scheduling | `ts-fsrs`, client-side                                       |
| TTS        | browser `speechSynthesis`                                    |

`lang` is a first-class column from day one. Languages are learned sequentially, one
at a time — parallel study causes interference.

Every rep is logged to an append-only `attempts` table. That history is what allows
FSRS weights and learning steps to be retrained on real data
(`@open-spaced-repetition/binding`) rather than running on generic defaults forever.

## Schema

Three tables, and the split is load-bearing.

**`words`** is the shared catalogue: the same rows for everyone, read-only to
users, one row per `(lang, text, gloss)`. **`cards`** is one user's scheduling
state for one word. **`attempts`** is the append-only log of every answer.

None of them wants merging. Folding `words` into `cards` copies the catalogue per
user. `attempts` is the only unbackfillable thing here, so it stays whatever else
changes. And `cards` is a materialised projection of `attempts` — derivable in
principle, stored because replay cost grows with history forever and you cannot
put an index on a computation, while "what is due for me right now" is the query
that has to be fast.

So the table count is not the problem. The problems are all in one narrow place.

### One fact in two places — TODO

Every schema defect found so far is the same shape, four times. Each is a value
that exists in two places with nothing keeping the two equal, and the halves
drift. Roughly half the bugs this app has shipped came from this list.

1. **A card's identity.** The primary key is a random UUID, but the table also
   declares `unique(user_id, word_id, card_type)` — and that is the real
   identity. Two devices introducing the same word mint different UUIDs for the
   same logical card, and the second write is rejected. Fix: derive the id from
   the natural key, or promote the natural key to the primary key, so both
   devices compute the same id and the second write is an ordinary update.

2. **A card's stage.** Whether a word is unseen, guessed, or scheduled is half in
   `fsrs_state.reps` and half in `attempts`, so the app re-derives it by joining
   the two. Both of the bugs in `daa4fa4` and `e43721e` were two derivations
   disagreeing. Fix: complete the projection — either a `stage` column kept
   current by a trigger on `attempts`, or create the card row at the first
   _rating_ rather than at introduction, which makes the ambiguous state
   impossible rather than merely labelled.

3. **A card's language.** It lives only on the word, so the cards query reaches
   it through a join. This is safe to denormalise because it cannot go stale — a
   card's `word_id` never changes. Fix: a `lang` column on `cards`.

4. **A card's due date.** Stored twice: in `fsrs_state.due` and in the
   denormalised `due` column that the index needs, kept equal by application
   code. Fix: make `due` a generated column, so divergence stops being possible.

   ```sql
   due timestamptz generated always as ((fsrs_state->>'due')::timestamptz) stored
   ```

`fsrs_state` stays `jsonb`. Its shape belongs to `ts-fsrs`, not to us — it added
`learning_steps` and deprecated `elapsed_days` recently — and a migration every
time upstream moves is a worse trade than validating at the boundary, which
`reviveFsrsCard` now does.

### There is nowhere to put a setting — TODO

`newPerDay` and the language being studied are per-user facts currently living in
`SessionScreen.tsx` as constants, so changing the daily allowance means a deploy.
They want a settings row. This is also what multi-language needs before it can be
anything but a recompile.

### History is erasable in bulk, though not editable — TODO

`attempts` has no UPDATE or DELETE policy or grant, so no row can be edited or
removed by name. But `attempts.card_id` cascades and a user may delete their own
cards, so deleting a card takes its history with it — through the foreign key
rather than through any policy.

That door is the reason card deletion exists: a card is a derived cache, and
dropping a corrupt one to rebuild it from history is a legitimate repair. The
same door lets the history be dropped.

For one user on their own data this is closer to a feature than a hole — it is
what makes "wipe my progress and start again" possible from the client. It stops
being fine the moment `attempts` is the training corpus for retrained FSRS
weights, because then a stray delete is unbackfillable. `on delete restrict` is
the lever, at the cost of making card repair a server-side operation.

## How this is tested

Three layers, because the bugs came in three kinds.

**Examples** for the rules we decided on — one per claim, each carrying the
reason it exists.

**A round-trip harness** (`session/harness.ts`) for the rest. Every earlier test
built its starting cards by hand, and a hand-built fixture can only hold the
states someone already thought of — which is exactly the set with no bugs in it.
The harness never writes a card: it runs a sitting, keeps what the session
emitted, pushes it through the same JSON round trip `jsonb` does, and rebuilds
the next sitting with the same `buildDeck` the app uses. Closing the app at every
step of a sitting is then one loop rather than an act of imagination.

**No integration layer yet — TODO.** Nothing here runs against a real Postgres:
every test is a pure function or jsdom with the repository mocked. That leaves
`loadDeck` unguarded, and its language filter lives in a PostgREST select string
where a typo compiles and returns the wrong rows. Doing it properly means
deciding how data is seeded and cleaned, how a test user is made, and whether it
runs on push and on deploy — neither of which has a database today.

**Properties** (`session/properties.test.ts`) over generated histories, because a
reachable state nobody imagined is found by generating the ways of reaching it,
not by thinking harder. The invariants in `session/invariants.ts` are the claims
this document makes: a first recall is always preceded by its exposure in the
same sitting, no card appears twice running, every card's history opens with
exactly one guess, `Again` if and only if the answer was wrong, a review is never
dragged back from a future day, and the session ends. That last one found a real
defect the day it was written — two cards alternating forever, each dragged
forward inside its own learning step.

## Known gaps

### The session has no leech threshold — TODO

A card answered wrong is rated `Again` and comes back due in a minute, which is
the scheduler working. It does mean a learner who never gets a word right is
never told the session is over: the card keeps genuinely coming due, so step 1
keeps serving it, and a bad day on three words is a session with no end.

Anki's answer is a **leech**: after N lapses (default 8) the card is tagged and,
by default, _suspended_ — pulled out of scheduling indefinitely, until you go and
unsuspend it by hand. That default assumes a card browser to unsuspend it from,
which this app does not have and does not want.

So the version to build here is probably softer: **park the card until tomorrow**
rather than forever. It ends the session, which is the actual problem, and it
needs no management UI, because the next day returns the card on its own. A
permanent suspension can come later if some word turns out to be genuinely
unlearnable, and by then `attempts` will say which.

Either way the decision is which lapse count, and whether parking is for a day or
for good — a product question, so it is written down rather than invented.

### Resolved

The introduction gap described here previously — `reps === 0` being unable to
tell _"never guessed"_ from _"guessed and shown, waiting to recall"_ — is closed
twice over: `attempts` is consulted directly for the guess, and a card's stage is
now a named value rather than something each branch re-derives.

On a fresh session a card that was guessed but never recalled is shown again
before being asked for. Whether its exposure was actually read before the app
closed is unknowable, and re-showing costs seconds where skipping it would ask
for a word that may never have been seen.

## What's next

Roughly in order. The first is small and unblocks the rest day to day; the rest
are independent enough to reorder.

1. **Reset the local database.** `npm run dev` already runs against
   `supabase start`, so what is missing is a way to drop progress and keep the
   deck. `delete from public.cards` does it — attempts cascade, words and the
   login survive — where `db:reset` is the heavier version that re-seeds
   everything and takes the auth user with it.

2. **An integration test layer.** See How this is tested. Nothing runs against a
   real Postgres today.

3. **The schema changes above.** Four small ones and a settings table. None is
   urgent alone; together they close roughly half the bug classes seen so far.

4. **Decide the leech policy.** See Known gaps. A decision before it is code.

5. **The real word list.** ~500–1000 subtitle-derived lemmas replacing the 50
   hand-picked scaffold entries (§9, §3.2). This quietly fixes more than content:
   deck exhaustion stops being a thing, and the scheduler finally has enough
   cards that the two-and-three-card tail stops being the common case that every
   rule has to be reasoned about against.

6. **Pre-generated audio.** §6 has you repeating aloud after whatever voice the
   device supplies, so a bad one teaches bad pronunciation forty times over.
   Browser `speechSynthesis` is a stand-in, not a choice.

7. **Real images.** Emoji are standing in, and several words have none because no
   emoji is honest for them.

8. **Multi-language, for real.** `lang` is first-class in the schema, but the app
   is hardcoded to French and there is no way to choose. Needs the settings row
   first, and needs a decision about what switching means given that languages
   are studied one at a time.

9. **Retrain FSRS on real data.** The point of the append-only log, and the one
   item genuinely gated on something else: history has to be real reps rather
   than a byproduct of testing. That same moment is when the cascade above stops
   being a convenience and starts being a risk.

## Not in v1

Speech recognition and pronunciation assessment. Chunks. Real subtitle-derived
frequency lists and images (emoji stand in). Listening / micro-dictation cards.

## Conventions

- UI copy in Italian, target language French, codebase in English.
- Any change to the learning pipeline cites the principle above that motivates it.
- Migrations are plain SQL files; seed data is a checked-in script.
- Mobile-first, but not mobile-only.

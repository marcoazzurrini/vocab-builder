# vocab-builder

A vocabulary learning app built on the evidence about how vocabulary is actually
acquired. French first, Italian as L1. Spanish and German planned.

Personal project, single user, built to last — not a bootstrapping tool with an
expiry date.

## Status

Deployed and usable: sign in with a magic link, answer cards, progress is saved.
`src/session/` owns the whole pipeline behind one function. Still to do:
pre-generated audio, and the gaps below.

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

1. A rated card is due → show it.
2. An introduction was left unfinished → resume it, without spending allowance.
3. Today's new-word allowance is not used up → introduce a new word.
4. A review is due today → show it.
5. Otherwise, pull forward the soonest-due card **that is still in its learning
   steps today**, never the one just answered.
6. Nothing left within today → the session is over.

An unrated card is not a scheduled card — it is a word that has not been
introduced yet, so step 2 hands it back to the introduction path. Scheduling it
instead is what once asked for a word that had never been shown, since every
scheduled card goes straight to recall. See Known gaps.

Step 5 is deliberately bounded. Pulling forward a card due in five minutes is
nearly free — it is mid-learning and the gap was minutes either way. Pulling
forward a card due in three days throws away three days of earned spacing, and
spacing is where nearly all of the retention comes from. It also empties
tomorrow, which invites doing it again, and the collection drifts toward massing.
Anki draws its line in the same place: learn-ahead applies only to learning
cards, never to mature reviews from future days.

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
  extend to the tail. With two or three cards left, step 5 will hand back the
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
- **`œ` → `oe`.** French writes it both ways.
- **Apostrophes**, straight `'` (U+0027) and curly `’` (U+2019), to one form.
  Keyboards disagree
  about which they emit.
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

## Known gaps

### Resuming an introduction re-asks for the guess

A word's introduction is guess → exposure → recall. The card is written at the
start, because the guess attempt has a foreign key pointing at it, so quitting
part-way leaves a card with no rating.

Those cards are now handed back to the introduction path rather than scheduled
(they were once surfaced as recalls, which asked for a word that had never been
shown). But `reps === 0` cannot distinguish _"never guessed"_ from _"guessed,
saw the answer, quit before typing it"_ — guesses are never rated, so both look
identical. The second case re-asks for a guess you can no longer make honestly,
and records it as correct.

**The correct fix is to ask `attempts`**, which is the source of truth: no guess
logged → start at the guess; a guess logged but no recall → resume at the
exposure. That is precise, never asks for an unseen word, and never records a
guess made with the answer already known.

It costs one extra query in `loadDeck` and a per-card flag threaded into the
session, which is why it is not done yet. The window is narrow — quitting in the
seconds between seeing the word and typing it — and the damage is one inflated
statistic rather than a broken schedule. Worth doing before guess-accuracy is
ever reported as a number, since `attempts` is append-only and the contaminated
rows cannot be cleaned up afterwards.

## Not in v1

Speech recognition and pronunciation assessment. Chunks. Real subtitle-derived
frequency lists and images (emoji stand in). Listening / micro-dictation cards.

## Conventions

- UI copy in Italian, target language French, codebase in English.
- Any change to the learning pipeline cites the principle above that motivates it.
- Migrations are plain SQL files; seed data is a checked-in script.
- Mobile-first, but not mobile-only.

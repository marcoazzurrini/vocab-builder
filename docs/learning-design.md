# Learning design

A vocabulary learning app built on the evidence about how vocabulary is actually acquired. French first, Italian as L1. Spanish and German planned.

Personal project, single user, built to last — not a bootstrapping tool with an expiry date.

This document records the learning principles, scheduling rules, and product direction. See the [repository overview](../README.md) for the current structure and [development guide](development.md) for setup and deployment.

## Research foundations

These are the spec. Design decisions trace back to them.

1. **Productive recall beats recognition.** Typing the L2 word from an L1 prompt produces the largest gains. Multiple-choice is measurably worse. Direction matters: L1→L2 trains production, L2→L1 trains comprehension.
2. **Encoding should be tiny.** One clean exposure — see the word, hear it, say it aloud — then straight into retrieval. Learning happens during retrieval with feedback, not during study.
3. **Pretesting / errorful generation.** Guessing before first exposure improves retention even when the guess is wrong. No penalty for wrong guesses.
4. **Spacing with expanding intervals.** Spaced ≈ 1.6× massed at one week. Expanding gaps slightly beat equal gaps.
5. **No semantic clustering.** Never batch related words (all colours, all animals) — they interfere. Frequency-ordered, thematically mixed.
6. **Audio from day one.** Aural word knowledge predicts listening comprehension better than written knowledge. Every card plays TTS; the user repeats aloud.
7. **Chunks are vocabulary too.** High-frequency formulaic sequences ("je voudrais…") are stored and retrieved as single units, and carry grammar for free.
8. **Unit = lemma, not word family.** One card per dictionary form. Inflection is grammar's job; derivations get their own card only when frequent enough.
9. **Frequency lists from subtitle corpora**, filtered to exclude pure function words.

## The pipeline

There is no learning phase and strengthening phase — they are the same exercise. The first meeting is rep zero.

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

One scheduler, not two. `ts-fsrs` with `learning_steps` and `enable_short_term` handles both same-session reps and across-day reviews. Gaps come from FSRS's difficulty/stability estimate, never a hardcoded ladder, and graduation is not a step count — it is the interval genuinely exceeding a day.

**The session never makes you wait — and never lies about being done.** A due time is not an appointment, so every gap that can honestly be filled is filled: the next card is chosen by this rule. But when nothing is servable right now and a card is still coming today, the session says so — caught up, next card at such a time — and the screen rebuilds itself when that time arrives. This is Anki's congratulations screen, adopted deliberately: the earlier design ended the day by force instead, and everything it needed to make that safe (a leech policy, a last-resort serving bound) existed only to prop up an ending that was sometimes a lie. "Done" now means exactly one thing: nothing more within today.

1. A rated learning card is due → ask for it, unless it is the one just answered.
2. Today's new-word allowance is not used up → introduce a new word.
3. A review is due today and was not rated during this study day → ask for it.
4. A word is waiting for its first recall and this sitting has not shown it → show it.
5. A word has been shown and is waiting to be asked for → ask for it, unless it is the one just shown.
6. Otherwise, pull forward the soonest-due card **that is still in its learning steps today**, never the one just answered and never twice in a sitting.
7. A word just shown, when there is nothing else at all → ask for it.
8. The card just answered has come due again, and there is nothing else at all → ask for it.
9. Nothing due right now, but a card still coming today → caught up: say when, and pause.
10. Nothing left within today → the session is over.

**Review follows calendar study days, not elapsed 24-hour windows.** A card rated into Review is not eligible again until the next rollover, including after reopening. On a 25-hour day, FSRS's next due time can still fall within the current study day; serving it immediately would discard the earned spacing. Learning and Relearning keep their minute-scale due-time and learn-ahead rules.

This list is the code. `packages/spaced-repetition/src/select-next-step.ts` holds one named rule per line and an array in this order, because prose and precedence living in different places is how they came to disagree.

**A card's stage is a value, not an inference.** `awaiting` (guessed, and FSRS has still never rated it), `scheduled` (rated) — and before either, nothing: no row, no state, a word that simply has not been introduced. FSRS cannot own the awaiting stage: it has no opinion about a card it has never rated, since the first rating is its input and not its output. Every bug this pipeline has shipped came from two places deriving the stage differently from `reps`, `state`, `due`, a guessed flag and a set of ids held in the session — so it is derived once now, and the rule asks what a card _is_ rather than reconstructing it from parts. There used to be a third stage, `unseen` — a row written at introduction that no guess had reached, an artefact of attempts needing a card row for their foreign key. Attempts are keyed by word now, so nothing is written until the guess and the ambiguous state cannot exist.

**The exposure returns to the queue, it does not fall through to the recall.** Producing a word two seconds after being shown it is trivial, and the rating it yields is FSRS's _first_ — the one that sets the card's initial difficulty. An immediate recall makes that rating measure short-term memory rather than the word, which wastes the very signal we protect by refusing to rate guesses.

Steps 4 and 5 are separate for the same reason. Returning to the queue only helps if the queue can tell that the exposure happened, and it could not: an exposure changed nothing the rule could see, so it handed the same card straight back on every resumed sitting. Splitting the two means a batch of resumed words is shown through before any of them is asked for — the shape a fresh sitting already had.

Both sit after the reviews, so a batch is introduced, the day's reviews are worked through, and only then are the new words asked for. Ordering is the honest lever here rather than an interval we invented to sit alongside FSRS.

An unrated card is not a scheduled card — it is a word that was guessed and never rated, so step 4 shows it again before step 5 asks for it. Scheduling it instead is what once asked for a word that had never been shown, since every scheduled card goes straight to recall.

Step 7 exists so that step 5's exclusion cannot starve a word: with one card and nothing else to do, coming straight back is right, because refusing would show a word and never ask for it, again on the next sitting and the one after. It sits after everything else — including pulling a learning card forward — so that all of it goes first. An early review costs a little stability once; a rating #1 taken from the short-term buffer misprices the card for its whole life.

Step 8 is step 7's twin on the other side of a rating. Step 1 refuses the card just answered even when it is genuinely due — linger on the feedback screen past the learning step and the failed card has come due by the time the feedback is dismissed, and handing it straight back when anything else could go between is massing. When nothing else exists, refusing would mean announcing "caught up, next card now", which is a pause with nothing to pause for — so it is asked, last of all.

Step 6 is bounded twice over.

**To learning cards.** Pulling forward a card due in five minutes is nearly free — it is mid-learning and the gap was minutes either way. Pulling forward a card due in three days throws away three days of earned spacing, and spacing is where nearly all of the retention comes from. It also empties tomorrow, which invites doing it again, and the collection drifts toward massing. Anki draws its line in the same place: learn-ahead applies only to learning cards, never to mature reviews from future days.

**To once per card per sitting**, which is what lets a sitting pause at all. A card dragged forward is answered, which schedules it a minute out, which is still today, so it is dragged forward again. "Never the same card twice running" stops the one-card cycle and nothing else, because two cards simply alternate — an hour later the sitting is still going, which is the padding this design exists to refuse. A card that genuinely comes due is served by step 1, which is uncapped and has earned it; a card whose free ride is spent waits for its real due time behind the caught-up screen.

So a sitting that has run out pauses honestly, not padded. On day one, 15 new words with no backlog is about nine minutes of work and then genuinely nothing to do, because every card is correctly parked two days out. Filling that time by dragging tomorrow's cards forward trades a durable gain for a few minutes of activity, and it compounds.

Pulling a card forward is safe: FSRS scores on _actual_ elapsed time, not scheduled time, so an early review is scored correctly. It simply earns less stability than the longer gap would have — a small, one-off cost, unlike dead air.

New words come before pulling forward, and the daily allowance is never exceeded to fill time. That limit exists to control future workload; overshooting it today makes every later day heavier, compounding. An early review costs a little stability once.

Two things a throwaway simulation established by measurement, against earlier guesses written here. The simulation itself was deleted in `fb6c255` once it had diverged from the real rule; `d317d5b` still holds it:

- **A minimum-interleave floor of 2 or 3 does nothing.** Floors of 0, 2 and 3 produce identical sessions and never bind, because the learning step already forces far larger gaps.

  That measurement was taken on sessions of ten cards or more, and it does not extend to the tail. With two or three cards left, step 7 will hand back the card just answered — massing with extra steps. So a floor of exactly **1** survives: never the same card twice in a row. When that leaves nothing, the session ends, because the gap it wanted cannot be filled today and tomorrow will fill it properly.

- **Once the session fills its gaps, the configured learning step barely matters.** `1m,3m` and `1m,10m` yield near-identical sessions, because real spacing is set by how many cards are in rotation, not by the clock — the step is a ceiling that rarely binds. So FSRS's defaults stand, and spacing widens on its own as the collection grows.

Measured at ~18s per answer: 10 new words ≈ 8 minutes and 28 answers, 30 new words ≈ 25 minutes, both with zero idle time.

### Grading

Typing gives objective pass/fail for free, which is the tedious part of self-grading. What remains is only "how easily did that come?".

| Situation | Grade | Interaction |
| --- | --- | --- |
| Pretest guess | _not rated_ — logged only | one action to continue |
| Correct | Hard / **Good** / Easy | grade buttons **are** submit — one action |
| Wrong (incl. wrong accent) | Again | two actions: see the answer, then continue |

- The first post-exposure recall is FSRS's rating #1, so the initial-difficulty signal is preserved. Grading every guess `Again` would carry zero information.
- Grading happens _before_ the answer is revealed. Retrieval ease is known the moment you finish typing, and the rating stays uncontaminated by the outcome.
- Enter = Good. The default path is one action and requires no grading decision.
- Wrong answers show the correct spelling with no diff highlighting — hunting for the difference is itself desirable difficulty.
- Response latency is logged, never graded. Too noisy to carry weight.

#### Answer comparison

One rule decides everything here: **orthography is graded, typography is not.** A missing accent changes the word. A ligature, a keyboard's choice of apostrophe, or a space before a question mark does not.

Graded — a mismatch is wrong:

- **Accents.** `fenetre` is not a French word.
- **Letters and word order**, obviously.

Normalised away before comparing:

- **Case and surrounding whitespace.**
- **Unicode composition**, to NFC. `ê` can arrive as one character or as `e` plus a combining circumflex; they render identically and compare unequal. Wrong answers are shown without diff highlighting on purpose, so this is the one mismatch the user could not possibly be expected to find.
- **`œ` → `oe`.** French writes it both ways.
- **Apostrophes**, straight `'` (U+0027), curly `’` (U+2019) and the four other single quotes keyboards emit, to one form.
- **Internal whitespace**, collapsed to single spaces. Matters for chunks.
- **Terminal punctuation**, `? ! .` stripped from both sides.

Terminal punctuation is still _stored_ and _displayed_, just never graded — and it is stored mainly for the audio. `speechSynthesis` reads `qu'est-ce que c'est ?` with rising question intonation and `qu'est-ce que c'est` flat. For a formulaic sequence the intonation contour is part of the chunk (§7).

## Stack

- **Frontend:** React, TanStack Start/Router, Vite.
- **Hosting/backend:** Cloudflare Workers and authenticated Start server functions.
- **Database:** Cloudflare D1 (SQLite), Drizzle ORM, checked-in SQL migrations.
- **Authentication:** Better Auth, private email allowlist, magic links, Resend delivery.
- **Scheduling:** `ts-fsrs` in the client for interaction and on the server for persisted state.
- **TTS:** browser `speechSynthesis`.

`lang` is a first-class column from day one. Languages are learned sequentially, one at a time — parallel study causes interference.

Every rep is logged to an append-only `attempts` table. That history is what allows FSRS weights and learning steps to be retrained on real data (`@open-spaced-repetition/binding`) rather than running on generic defaults forever.

## Schema

`packages/database/src/schema.ts` defines the Drizzle schema. `packages/database/migrations/` contains reviewed SQL, including append-only and revision-check triggers that Drizzle cannot express in its schema builder. Wrangler applies these migrations. Original catalogue SQL is preserved in `packages/database/tests/fixtures/legacy-catalogue/` for regression tests, not deployment.

One recall inserts its attempt and updates its card in a single D1 batch. Stable answer IDs make retries idempotent. Revision guards reject stale-device writes rather than overwrite newer progress. A user-scoped browser outbox keeps unacknowledged answers, pauses on failure, and supports retry. Clearing browser storage before synchronization can still lose unsaved answers.

## How this is tested

Learning tests, UI tests, persistence tests, and authentication integration tests.

**Examples** for the rules we decided on — one per claim, each carrying the reason it exists.

**A round-trip harness** (`packages/spaced-repetition/tests/support/learner-simulator.ts`) explores reachable histories alongside focused fixtures for difficult scheduling states. It uses public `createSession` and `evaluateAnswer`, serializes commands and server schedules through JSON, and reconstructs the next sitting from a public snapshot. It does not bypass command validation with internal persistence callbacks. Thinking time advances before the corresponding answer; the trace checks its latency, timestamp, word, phase, rating, and revision against the recorded attempt. Closing the app at every step is then one loop rather than an act of imagination.

**Failure contracts** exercise invalid actions in every phase, rejected acceptance, oversized answers, retries, and immutable snapshots. An action calculates a candidate state and validates its command before the local outbox accepts it. Only successful, synchronous acceptance publishes that state. Server synchronization remains a separate idempotent operation; network failure does not undo a locally accepted answer.

**D1 integration tests** run the checked-in migrations in isolated local `workerd` databases through Wrangler. They cover rollback when the second write fails, duplicate retries, racing recalls, ownership and language filters, constraints, and the preserved catalogue. Better Auth tests exercise actual magic-link verification, sessions, sign-out, and origin checks against D1. No hosted database or real email delivery is required.

**Properties** (`packages/spaced-repetition/tests/study-session-properties.test.ts`) over generated histories, because a reachable state nobody imagined is found by generating the ways of reaching it, not by thinking harder. The invariants in `packages/spaced-repetition/tests/support/trace-invariants.ts` are the claims this document makes: a first recall is always preceded by its exposure in the same sitting, a repeat exception is used only when no alternative work exists, every card's history opens with exactly one guess, `Again` if and only if the answer was wrong, a review is never dragged back from a future day, and a sitting reaches an honest pause. Completed, waiting, and manually interrupted sittings have distinct trace records. Invariant checkers have negative-control tests that deliberately corrupt histories and prove that the checks notice. That last one found a real defect the day it was written — two cards alternating forever, each dragged forward inside its own learning step.

## Known gaps

### No leech rule, on purpose — for now

A word failed over and over keeps genuinely coming due a minute later, and a learner failing it at a steady pace sees no pause — the same experience Anki gives, and the same exit: stop answering, and the caught-up screen is never more than a card away. A parking rule was built and then removed along with the forced day-ending it existed to prop up (`de6fe27` and its revert hold both sides of the argument). What remains of the idea is optional polish — giving up on a genuinely stuck word _sooner_ than the learner would — and that wants real data about how often it happens. `attempts` will say.

### Resolved

The introduction gap described here previously — `reps === 0` being unable to tell _"never guessed"_ from _"guessed and shown, waiting to recall"_ — is now closed structurally: nothing is written before the guess, so an unrated card can only mean one thing. The migration that made it so tells the whole story.

On a fresh session a card that was guessed but never recalled is shown again before being asked for. Whether its exposure was actually read before the app closed is unknowable, and re-showing costs seconds where skipping it would ask for a word that may never have been seen.

## What's next

The live catalogue import and Cloudflare deployment are complete. Retiring the hosted Supabase project remains a separate, explicit administrative action.

The remaining product work is independent enough to reorder.

1. **The real word list.** ~500–1000 subtitle-derived lemmas replacing the 50 hand-picked scaffold entries (§9, §3.2). This quietly fixes more than content: deck exhaustion stops being a thing, and the scheduler finally has enough cards that the two-and-three-card tail stops being the common case that every rule has to be reasoned about against.

2. **Pre-generated audio.** §6 has you repeating aloud after whatever voice the device supplies, so a bad one teaches bad pronunciation forty times over. Browser `speechSynthesis` is a stand-in, not a choice.

3. **Real images.** Emoji are standing in, and several words have none because no emoji is honest for them.

4. **Multi-language, for real.** `lang` is first-class in the schema and the settings row now chooses it, but there is no UI to switch and no decision about what switching means given that languages are studied one at a time.

5. **Retrain FSRS on real data.** The point of the append-only log, and the one item genuinely gated on something else: history has to be real reps rather than a byproduct of testing. The history it trains on can no longer be deleted from the client, which is what that moment needed.

## Not in v1

Speech recognition and pronunciation assessment. Real subtitle-derived frequency lists and images (emoji stand in). Listening / micro-dictation cards.

## Conventions

- UI copy in Italian, target language French, codebase in English.
- Any change to the learning pipeline cites the principle above that motivates it.
- Migrations are reviewed SQL files; the fallback seed is checked-in JSON.
- Mobile-first, but not mobile-only.

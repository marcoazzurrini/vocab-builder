# vocab-builder

A vocabulary learning app built on the evidence about how vocabulary is actually
acquired. French first, Italian as L1. Spanish and German planned.

Personal project, single user, built to last — not a bootstrapping tool with an
expiry date.

## Status

Pre-implementation. Pipeline and grading model are settled (below); data model,
seed content, and scaffolding are next.

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
handles both same-session reps (minute-scale) and across-day reviews. The session
queue is not a scheduler — it asks what is due soonest and shows it.

- Gaps come from FSRS's difficulty/stability estimate, never a hardcoded ladder.
- A minimum interleave floor (~2–3 intervening cards) prevents degenerate massed
  repetition when the queue runs thin.
- Graduation is not a step count — it is the interval genuinely exceeding a day.

### Grading

Typing gives objective pass/fail for free, which is the tedious part of self-grading.
What remains is only "how easily did that come?".

| Situation | Grade | Interaction |
|---|---|---|
| Pretest guess | *not rated* — logged only | one action to continue |
| Correct | Hard / **Good** / Easy | grade buttons **are** submit — one action |
| Wrong (incl. wrong accent) | Again | two actions: see the answer, then continue |

- The first post-exposure recall is FSRS's rating #1, so the initial-difficulty
  signal is preserved. Grading every guess `Again` would carry zero information.
- Grading happens *before* the answer is revealed. Retrieval ease is known the moment
  you finish typing, and the rating stays uncontaminated by the outcome.
- Enter = Good. The default path is one action and requires no grading decision.
- Comparison is accent-strict: `fenetre` is not a French word. `œ`/`oe` is tolerated
  — a ligature is typography, not orthography.
- Wrong answers show the correct spelling with no diff highlighting — hunting for the
  difference is itself desirable difficulty.
- Response latency is logged, never graded. Too noisy to carry weight.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vite + React SPA, no router (phase state is the router) |
| Hosting | Cloudflare Pages |
| Backend | none — `supabase-js` direct from the browser, RLS is the API |
| DB | Supabase Postgres |
| Auth | Supabase Auth, magic link |
| Scheduling | `ts-fsrs`, client-side |
| TTS | browser `speechSynthesis` |

`lang` is a first-class column from day one. Languages are learned sequentially, one
at a time — parallel study causes interference.

Every rep is logged to an append-only `attempts` table. That history is what allows
FSRS weights and learning steps to be retrained on real data
(`@open-spaced-repetition/binding`) rather than running on generic defaults forever.

## Not in v1

Speech recognition and pronunciation assessment. Chunks. Real subtitle-derived
frequency lists and images (emoji stand in). Listening / micro-dictation cards.

## Conventions

- UI copy in Italian, target language French, codebase in English.
- Any change to the learning pipeline cites the principle above that motivates it.
- Migrations are plain SQL files; seed data is a checked-in script.
- Mobile-first, but not mobile-only.

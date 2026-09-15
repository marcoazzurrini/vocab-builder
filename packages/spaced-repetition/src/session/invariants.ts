/**
 * The session's promises, written as checks over a trace. Test-only.
 *
 * These are not extra rules invented for the tests — each one is a claim the
 * README already makes, and two of them are bugs that shipped. Stating them here
 * means the next violation is a failing test rather than a session that asks for
 * a word it never showed.
 */

import { State } from "ts-fsrs";

import { studyBounds } from "./harness";
import type { Step } from "./harness";
import type { Attempt } from "./types";

/** A step that actually put something on screen. */
export type PromptStep = Exclude<Step, { at: "closed" }>;

/** Split a trace into sittings. `exposedThisSession` does not survive a close. */
export const sittings = (trace: readonly Step[]): PromptStep[][] => {
  let sitting: PromptStep[] = [];
  const out: PromptStep[][] = [sitting];
  for (const step of trace) {
    if (step.at === "closed") {
      sitting = [];
      out.push(sitting);
    } else {
      sitting.push(step);
    }
  }
  return out.filter((s) => s.length > 0);
};

/**
 * Never ask for a word that has not been shown.
 *
 * FSRS's rating #1 can only be earned by a card whose exposure happened in this
 * same sitting: closing the app loses the knowledge that the exposure was ever
 * read, so it has to be shown again. Violated by the bug fixed in daa4fa4.
 */
export const recallsWithoutExposure = (
  trace: readonly Step[]
): PromptStep[] => {
  const bad: PromptStep[] = [];
  for (const sitting of sittings(trace)) {
    const exposed = new Set<string>();
    for (const step of sitting) {
      if (step.at === "exposure") {
        exposed.add(step.word);
      }
      if (step.at === "recall" && step.first && !exposed.has(step.word)) {
        bad.push(step);
      }
    }
  }
  return bad;
};

/**
 * Show the whole batch before asking for any of it.
 *
 * The sharp form of the second bug. Producing a word seconds after seeing it is
 * trivial, and the rating it yields is FSRS's first — the one that sets initial
 * difficulty — so an exposure has to be separated from its recall by real work.
 * Once any card has been asked for, no card is still waiting to be shown.
 *
 * Stated this way rather than as "an exposure is never followed by its own
 * recall", because that adjacency is legitimate when it is the only card left:
 * refusing it would show a lone word and then never ask for it. This form has no
 * such exception — with one card it is trivially satisfied, and with two or more
 * it is exactly what the bug violated.
 */
export const exposuresAfterAFirstRecall = (
  trace: readonly Step[]
): PromptStep[] => {
  const bad: PromptStep[] = [];
  for (const sitting of sittings(trace)) {
    let asked = false;
    for (const step of sitting) {
      if (step.at === "recall" && step.first) {
        asked = true;
      } else if (step.at === "exposure" && asked) {
        bad.push(step);
      }
    }
  }
  return bad;
};

/**
 * Never the same card twice running.
 *
 * Four adjacencies are the pipeline working as designed: a guess is followed by
 * the exposure that answers it, a wrong recall is followed by the feedback that
 * corrects it, and — only when there is nothing else at all — an exposure is
 * followed by its own recall, or a failed card that came due during its own
 * feedback is asked again. Every other repeat is massing.
 */
export const repeatsInARow = (
  trace: readonly Step[]
): { previous: PromptStep; next: PromptStep }[] => {
  const allowed = new Set(["guess→exposure", "recall→feedback"]);
  const bad: { previous: PromptStep; next: PromptStep }[] = [];

  for (const sitting of sittings(trace)) {
    for (const [i, next] of sitting.entries()) {
      const previous = sitting[i - 1];
      if (!previous || previous.word !== next.word) {
        continue;
      }
      if (allowed.has(`${previous.at}→${next.at}`)) {
        continue;
      }
      if (
        (previous.at === "exposure" || previous.at === "feedback") &&
        next.at === "recall" &&
        !next.eligibleWordIds.some((id) => id !== next.wordId)
      ) {
        continue;
      }
      bad.push({ next, previous });
    }
  }
  return bad;
};

/**
 * Every card's history opens with exactly one guess.
 *
 * A pretest before the first exposure is the whole of §3, and `attempts` is
 * where the claim that it happened is stored — so if the table does not show it,
 * it did not happen, whatever the session believed at the time.
 */
export const historiesNotStartingWithOneGuess = (
  attempts: readonly Attempt[]
): string[] => {
  const byWord = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const list = byWord.get(a.wordId) ?? [];
    list.push(a);
    byWord.set(a.wordId, list);
  }

  const bad: string[] = [];
  for (const [wordId, history] of byWord) {
    const guesses = history.filter((a) => a.phase === "guess");
    if (history[0]?.phase !== "guess") {
      bad.push(`${wordId}: first attempt is not a guess`);
    } else if (guesses.length !== 1) {
      bad.push(`${wordId}: ${guesses.length} guesses`);
    }
  }
  return bad;
};

/**
 * A wrong answer is Again, with no exceptions. This mirrors the check constraint
 * in the schema, so a violation here is a write the database would also refuse.
 */
export const gradingContradictions = (
  attempts: readonly Attempt[]
): Attempt[] =>
  attempts.filter((a) => {
    if (a.phase === "guess") {
      return a.rating !== null;
    }
    if (a.rating === null) {
      return true;
    }
    // Rating.Again is 1.
    return a.correct ? a.rating === 1 : a.rating !== 1;
  });

/**
 * Never drag a review back from a future day.
 *
 * This is the guarantee the whole design argues for: spacing is where nearly all
 * of the retention comes from, and pulling a card forward from three days out
 * throws away three days of it and empties tomorrow, which invites doing it
 * again until the collection drifts toward massing. Learning cards are fair game
 * — minutes either way — and reviews are not.
 *
 * Checked from the attempts rather than the trace, because `stateBefore` records
 * exactly what the schedule said at the moment the card was put on screen.
 */
export const reviewsDraggedFromTheFuture = (
  attempts: readonly Attempt[],
  dayRolloverHour = 0
): Attempt[] =>
  attempts.filter((a) => {
    if (a.phase !== "recall" || a.stateBefore.state !== State.Review) {
      return false;
    }
    const shownAt = a.reviewedAt.getTime() - a.latencyMs;
    return (
      a.stateBefore.due.getTime() > studyBounds(shownAt, dayRolloverHour).end
    );
  });

const expectedRating = (
  step: Extract<Step, { at: "guess" | "recall" }>
): Attempt["rating"] => {
  if (step.at === "guess") {
    return null;
  }
  if (!step.correct) {
    return 1;
  }
  if (step.effort === "hard") {
    return 2;
  }
  return step.effort === "easy" && !step.first ? 4 : 3;
};

/** Compare answers with independently recorded actions, not just row counts. */
export const attemptMismatches = (
  trace: readonly Step[],
  attempts: readonly Attempt[]
): string[] => {
  const answered = trace.filter((s) => s.at === "guess" || s.at === "recall");
  const bad: string[] = [];
  if (answered.length !== attempts.length) {
    bad.push("answer/attempt count differs");
  }
  for (const [i, step] of answered.entries()) {
    const a = attempts[i];
    if (!a) {
      continue;
    }
    const rating = expectedRating(step);
    const expected = {
      correct: step.correct,
      latencyMs: Math.min(86_400_000, Math.max(0, step.actedAt - step.shownAt)),
      phase: step.at,
      rating,
      typed: step.typed,
      wordId: step.wordId,
    };
    // SAFETY: expected is a fresh object literal with exactly these own enumerable keys and no external additions.
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (a[key] !== expected[key]) {
        bad.push(`attempt ${i}: ${key} differs`);
      }
    }
    if (a.reviewedAt.getTime() !== step.actedAt) {
      bad.push(`attempt ${i}: reviewedAt differs`);
    }
    if (a.stateBefore.reps !== step.expectedReps) {
      bad.push(`attempt ${i}: previous reps differ`);
    }
  }
  return bad;
};

/** End screens are claims about remaining work, not synonyms for closing the app. */
export const closureContradictions = (trace: readonly Step[]): string[] => {
  const bad: string[] = [];
  for (const [i, step] of trace.entries()) {
    if (step.at !== "closed") {
      continue;
    }
    if (step.reason !== "cut" && step.eligibleWordIds.length) {
      bad.push(`close ${i}: eligible work remains`);
    }
    const earliest = Math.min(...step.remainingLearning.map((c) => c.due));
    if (step.reason === "done" && step.remainingLearning.length) {
      bad.push(`close ${i}: learning remains today`);
    }
    if (
      step.reason === "caughtUp" &&
      (!Number.isFinite(earliest) ||
        earliest <= step.atMs ||
        step.nextDueAt !== earliest)
    ) {
      bad.push(`close ${i}: incorrect next learning due`);
    }
    if (step.reason !== "caughtUp" && step.nextDueAt !== null) {
      bad.push(`close ${i}: unexpected nextDueAt`);
    }
    // Reopening at the promised due time must offer work rather than another end screen.
    const next = trace[i + 1];
    if (
      step.reason === "caughtUp" &&
      next?.at === "closed" &&
      next.atMs === step.nextDueAt
    ) {
      bad.push(`close ${i}: no work on reopening at nextDueAt`);
    }
  }
  return bad;
};

/** Every check at once, as a list of human-readable failures. */
export const violations = (
  trace: readonly Step[],
  attempts: readonly Attempt[],
  dayRolloverHour = 0
): string[] => [
  ...attemptMismatches(trace, attempts),
  ...closureContradictions(trace),
  ...reviewsDraggedFromTheFuture(attempts, dayRolloverHour).map(
    (a) =>
      `review on ${a.wordId} was due ${a.stateBefore.due.toISOString()} ` +
      `but shown ${a.reviewedAt.toISOString()}`
  ),
  ...recallsWithoutExposure(trace).map(
    (s) =>
      `first recall of ${s.word} with no exposure before it in this sitting`
  ),
  ...exposuresAfterAFirstRecall(trace).map(
    (s) =>
      `${s.word} was still waiting to be shown after a first recall had happened`
  ),
  ...repeatsInARow(trace).map(
    ({ previous, next }) =>
      `${previous.word}: ${previous.at} followed straight by ${next.at}`
  ),
  ...historiesNotStartingWithOneGuess(attempts),
  ...gradingContradictions(attempts).map(
    (a) => `${a.phase} on ${a.wordId}: correct=${a.correct} rating=${a.rating}`
  ),
];

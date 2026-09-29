/**
 * The session's promises, written as checks over a trace. Test-only.
 *
 * Each check enforces a promise in docs/learning-design.md independently of the
 * production selection rules. Negative-control tests corrupt traces to prove
 * that the checks detect violations.
 */

import { State } from "ts-fsrs";

import type { Attempt, TeachingAttempt } from "../../src/answer-command";
import { studyBounds } from "./learner-simulator";
import type { Step } from "./learner-simulator";

/** A step that actually put something on screen. */
export type PromptStep = Exclude<Step, { at: "closed" }>;

/** Split a trace into sittings for adjacency and batch-order checks. */
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

/** Never ask for an untaught word. Completed teaching survives a close. */
export const recallsWithoutExposure = (
  trace: readonly Step[]
): PromptStep[] => {
  const bad: PromptStep[] = [];
  const exposed = new Set<string>();
  for (const step of trace) {
    if (step.at === "exposure") {
      exposed.add(step.wordId);
    }
    if (step.at === "recall" && step.first && !exposed.has(step.wordId)) {
      bad.push(step);
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
 * First recall also requires a full minute after teaching, checked separately.
 * A lone word waits instead of bypassing that spacing floor.
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
 * A wrong recall is followed by its corrective feedback. A failed card that
 * came due during feedback may recur only when no other work can intervene.
 * Teaching never bypasses the first-recall spacing floor.
 */
export const repeatsInARow = (
  trace: readonly Step[]
): { previous: PromptStep; next: PromptStep }[] => {
  const allowed = new Set(["recall→feedback"]);
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
        previous.at === "feedback" &&
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

/** Every newly generated history has exactly one durable teaching before recall. */
export const historiesNotStartingWithOneTeaching = (
  attempts: readonly Attempt[],
  teachings: readonly TeachingAttempt[]
): string[] => {
  const bad: string[] = [];
  const wordIds = new Set([...attempts, ...teachings].map((a) => a.wordId));
  for (const wordId of wordIds) {
    const rows = teachings.filter((t) => t.wordId === wordId);
    if (rows.length !== 1) {
      bad.push(`${wordId}: ${rows.length} teachings`);
      continue;
    }
    for (const attempt of attempts.filter((a) => a.wordId === wordId)) {
      if (attempt.phase !== "recall") {
        bad.push(`${wordId}: new history contains a guess`);
      }
      const [teaching] = rows;
      if (
        teaching &&
        attempt.reviewedAt.getTime() - attempt.latencyMs <
          teaching.reviewedAt.getTime()
      ) {
        bad.push(`${wordId}: recalled before teaching`);
      }
    }
  }
  return bad;
};

/** First recall is never pulled forward, including after reopening. */
export const firstRecallsTooSoon = (trace: readonly Step[]): PromptStep[] => {
  const taughtAt = new Map<string, number>();
  const bad: PromptStep[] = [];
  for (const step of trace) {
    if (step.at === "exposure") {
      taughtAt.set(step.wordId, step.actedAt);
    } else if (step.at === "recall" && step.first) {
      const completed = taughtAt.get(step.wordId);
      if (completed !== undefined && step.shownAt < completed + 60_000) {
        bad.push(step);
      }
    }
  }
  return bad;
};

/** Teaching is an event, not a graded answer or an FSRS review. */
export const teachingMismatches = (
  trace: readonly Step[],
  teachings: readonly TeachingAttempt[]
): string[] => {
  const exposures = trace.filter((s) => s.at === "exposure");
  const bad: string[] = [];
  if (exposures.length !== teachings.length) {
    bad.push("exposure/teaching count differs");
  }
  for (const [i, step] of exposures.entries()) {
    const teaching = teachings[i];
    if (!teaching) {
      continue;
    }
    if (
      Object.keys(teaching).toSorted().join(",") !==
        "latencyMs,phase,reviewedAt,wordId" ||
      teaching.phase !== "teach" ||
      teaching.wordId !== step.wordId ||
      teaching.reviewedAt.getTime() !== step.actedAt ||
      teaching.latencyMs !==
        Math.min(86_400_000, Math.max(0, step.actedAt - step.shownAt))
    ) {
      bad.push(`teaching ${i}: event differs`);
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
  step: Extract<Step, { at: "recall" }>
): Attempt["rating"] => {
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
  const answered = trace.filter((s) => s.at === "recall");
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
  dayRolloverHour = 0,
  teachings: readonly TeachingAttempt[] = []
): string[] => [
  ...attemptMismatches(trace, attempts),
  ...teachingMismatches(trace, teachings),
  ...firstRecallsTooSoon(trace).map(
    (s) => `${s.word}: first recall before teaching + 60 seconds`
  ),
  ...closureContradictions(trace),
  ...reviewsDraggedFromTheFuture(attempts, dayRolloverHour).map(
    (a) =>
      `review on ${a.wordId} was due ${a.stateBefore.due.toISOString()} ` +
      `but shown ${a.reviewedAt.toISOString()}`
  ),
  ...recallsWithoutExposure(trace).map(
    (s) => `first recall of ${s.word} with no completed teaching before it`
  ),
  ...exposuresAfterAFirstRecall(trace).map(
    (s) =>
      `${s.word} was still waiting to be shown after a first recall had happened`
  ),
  ...repeatsInARow(trace).map(
    ({ previous, next }) =>
      `${previous.word}: ${previous.at} followed straight by ${next.at}`
  ),
  ...historiesNotStartingWithOneTeaching(attempts, teachings),
  ...gradingContradictions(attempts).map(
    (a) => `${a.phase} on ${a.wordId}: correct=${a.correct} rating=${a.rating}`
  ),
];

/**
 * The session's promises, written as checks over a trace. Test-only.
 *
 * These are not extra rules invented for the tests — each one is a claim the
 * README already makes, and two of them are bugs that shipped. Stating them here
 * means the next violation is a failing test rather than a session that asks for
 * a word it never showed.
 */

import { State } from "ts-fsrs";
import type { Step } from "./harness";
import type { Attempt } from "./types";

/** A step that actually put something on screen. */
export type PromptStep = Exclude<Step, { at: "closed" }>;

/** Split a trace into sittings. `exposedThisSession` does not survive a close. */
export function sittings(trace: readonly Step[]): PromptStep[][] {
  const out: PromptStep[][] = [[]];
  for (const step of trace) {
    if (step.at === "closed") out.push([]);
    else out.at(-1)!.push(step);
  }
  return out.filter((s) => s.length > 0);
}

/**
 * Never ask for a word that has not been shown.
 *
 * FSRS's rating #1 can only be earned by a card whose exposure happened in this
 * same sitting: closing the app loses the knowledge that the exposure was ever
 * read, so it has to be shown again. Violated by the bug fixed in daa4fa4.
 */
export function recallsWithoutExposure(trace: readonly Step[]): PromptStep[] {
  const bad: PromptStep[] = [];
  for (const sitting of sittings(trace)) {
    const exposed = new Set<string>();
    for (const step of sitting) {
      if (step.at === "exposure") exposed.add(step.card);
      if (step.at === "recall" && step.first && !exposed.has(step.card)) bad.push(step);
    }
  }
  return bad;
}

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
export function exposuresAfterAFirstRecall(trace: readonly Step[]): PromptStep[] {
  const bad: PromptStep[] = [];
  for (const sitting of sittings(trace)) {
    let asked = false;
    for (const step of sitting) {
      if (step.at === "recall" && step.first) asked = true;
      else if (step.at === "exposure" && asked) bad.push(step);
    }
  }
  return bad;
}

/**
 * Never the same card twice running.
 *
 * Four adjacencies are the pipeline working as designed: a guess is followed by
 * the exposure that answers it, a wrong recall is followed by the feedback that
 * corrects it, and — only when there is nothing else at all — an exposure is
 * followed by its own recall, or a failed card that came due during its own
 * feedback is asked again. Every other repeat is massing.
 */
export function repeatsInARow(
  trace: readonly Step[],
): { previous: PromptStep; next: PromptStep }[] {
  const allowed = new Set([
    "guess→exposure",
    "recall→feedback",
    "exposure→recall",
    "feedback→recall",
  ]);
  const bad: { previous: PromptStep; next: PromptStep }[] = [];

  for (const sitting of sittings(trace)) {
    for (let i = 1; i < sitting.length; i++) {
      const previous = sitting[i - 1]!;
      const next = sitting[i]!;
      if (previous.card !== next.card) continue;
      if (allowed.has(`${previous.at}→${next.at}`)) continue;
      bad.push({ previous, next });
    }
  }
  return bad;
}

/**
 * Every card's history opens with exactly one guess.
 *
 * A pretest before the first exposure is the whole of §3, and `attempts` is
 * where the claim that it happened is stored — so if the table does not show it,
 * it did not happen, whatever the session believed at the time.
 */
export function historiesNotStartingWithOneGuess(attempts: readonly Attempt[]): string[] {
  const byCard = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const list = byCard.get(a.cardId) ?? [];
    list.push(a);
    byCard.set(a.cardId, list);
  }

  const bad: string[] = [];
  for (const [cardId, history] of byCard) {
    const guesses = history.filter((a) => a.phase === "guess");
    if (history[0]?.phase !== "guess") bad.push(`${cardId}: first attempt is not a guess`);
    else if (guesses.length !== 1) bad.push(`${cardId}: ${guesses.length} guesses`);
  }
  return bad;
}

/**
 * A wrong answer is Again, with no exceptions. This mirrors the check constraint
 * in the schema, so a violation here is a write the database would also refuse.
 */
export function gradingContradictions(attempts: readonly Attempt[]): Attempt[] {
  return attempts.filter((a) => {
    if (a.phase === "guess") return a.rating !== null;
    if (a.rating === null) return true;
    // Rating.Again is 1.
    return a.correct ? a.rating === 1 : a.rating !== 1;
  });
}

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
export function reviewsDraggedFromTheFuture(attempts: readonly Attempt[]): Attempt[] {
  return attempts.filter((a) => {
    if (a.phase !== "recall" || a.stateBefore.state !== State.Review) return false;
    const endOfThatDay = new Date(a.reviewedAt);
    endOfThatDay.setHours(23, 59, 59, 999);
    return a.stateBefore.due > endOfThatDay;
  });
}

/** Every check at once, as a list of human-readable failures. */
export function violations(trace: readonly Step[], attempts: readonly Attempt[]): string[] {
  return [
    ...reviewsDraggedFromTheFuture(attempts).map(
      (a) =>
        `review on ${a.cardId} was due ${a.stateBefore.due.toISOString()} ` +
        `but shown ${a.reviewedAt.toISOString()}`,
    ),
    ...recallsWithoutExposure(trace).map(
      (s) => `first recall of ${s.word} with no exposure before it in this sitting`,
    ),
    ...exposuresAfterAFirstRecall(trace).map(
      (s) => `${s.word} was still waiting to be shown after a first recall had happened`,
    ),
    ...repeatsInARow(trace).map(
      ({ previous, next }) => `${previous.word}: ${previous.at} followed straight by ${next.at}`,
    ),
    ...historiesNotStartingWithOneGuess(attempts),
    ...gradingContradictions(attempts).map(
      (a) => `${a.phase} on ${a.cardId}: correct=${a.correct} rating=${a.rating}`,
    ),
  ];
}

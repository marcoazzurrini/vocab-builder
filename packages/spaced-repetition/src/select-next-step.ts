import { State } from "ts-fsrs";

import type { Word } from "./restore-progress";
import type { Card } from "./review-scheduling";
import { studyDay } from "./study-day";

/** Unrated teaching progress is separate from FSRS scheduling. */
export type Stage =
  /** Waiting for teaching or the first real recall. */
  | "awaiting"
  /** Rated at least once. FSRS owns it from here. */
  | "scheduled";

/** `reps` counts real FSRS ratings, never teaching. */
export const stageOf = (card: Card): Stage =>
  card.fsrs.reps > 0 ? "scheduled" : "awaiting";

/**
 * What to do next — not which card to show next.
 *
 * The two used to be different questions: this returned a card, and the session
 * separately decided whether that meant an exposure or a recall. The fact the
 * second decision needed lived only in the session, so the rule could not see
 * it, and the two answers drifted. There is one decision now, so there is
 * nothing left to drift.
 */
export type Slot =
  | { do: "introduce"; word: Word }
  | { do: "expose"; card: Card }
  /** `pulledForward` marks filler: a card shown before it was actually due. */
  | { do: "recall"; card: Card; pulledForward?: true }
  /** Nothing due right now, but a card is still coming: caught up. */
  | { do: "wait"; until: Date }
  | { do: "done" };

/** Optional queue limits for a bounded practice block, never FSRS settings. */
export interface PracticePolicy {
  /** Permit new introductions within the existing daily allowance. */
  allowNew: boolean;
  /** Prioritize genuinely due recalls and disable all learn-ahead. */
  dueOnly: boolean;
}

export interface Queue {
  practicePolicy?: PracticePolicy;
  cards: readonly Card[];
  words: readonly Word[];
  now: Date;
  /** Today's remaining new-word ceiling. Never exceeded to fill time. */
  allowanceLeft: number;
  /**
   * Words already pulled forward once in this sitting.
   *
   * Without this the session cannot end. A card dragged forward is answered,
   * which schedules it a minute out, which is still today — so it is dragged
   * forward again, and again. Never the same card twice running stops the
   * one-card cycle and nothing else: with two cards they simply alternate, and
   * an hour later the session is still going, which is the padding this design
   * exists to refuse.
   *
   * Once is the honest ceiling. A card that genuinely comes due is served by the
   * first rule, which has earned it; a card that has already had its free ride
   * and is still not due is asking for spacing that today cannot give it, and
   * tomorrow can.
   */
  pulledForward: ReadonlySet<string>;
  /**
   * The word answered a moment ago.
   *
   * A minimum-interleave floor of 2 or 3 measured as doing nothing, but that was
   * on sessions of ten cards or more. In the tail, a floor of exactly 1 — never
   * the same card twice running — is what stops the last two cards being handed
   * back and forth, which is massing with extra steps.
   */
  justShownId?: string;
  /** The hour the study day rolls over. Midnight unless told otherwise. */
  dayRolloverHour?: number;
}

type Rule = (q: Queue) => Slot | null;

const isLearning = (card: Card): boolean =>
  card.fsrs.state === State.Learning ||
  card.fsrs.state === State.Relearning ||
  // Rated but still New should not happen; showing it beats stranding it.
  card.fsrs.state === State.New;

const nextDay = (q: Queue): Date =>
  studyDay(q.now, q.dayRolloverHour ?? 0).nextStart;

const earliestDue = (cards: readonly Card[]): Card | undefined => {
  let best: Card | undefined;
  for (const card of cards) {
    if (!best || card.fsrs.due < best.fsrs.due) {
      best = card;
    }
  }
  return best;
};

const at = (q: Queue, stage: Stage): Card[] =>
  q.cards.filter((c) => stageOf(c) === stage);

/**
 * 1. A rated learning card that is genuinely due. Minute-scale, time-critical.
 *
 * Never the card just answered, even though it can genuinely be due: linger on
 * the feedback screen past the learning step and the failed card has come due
 * by the time the feedback is dismissed. Serving it straight back when anything
 * else could go between is massing. When nothing else can, the last rule of all
 * still serves it.
 */
const dueLearning: Rule = (q) => {
  const card = earliestDue(
    at(q, "scheduled").filter(
      (c) => isLearning(c) && c.fsrs.due <= q.now && c.wordId !== q.justShownId
    )
  );
  return card ? { card, do: "recall" } : null;
};

/**
 * 2. A new word, while today's allowance lasts.
 *
 * Before the reviews, so that a new word's second recall lands *inside* the
 * review block — the longest gap the session can give it for free.
 *
 * Nothing is written until teaching completes. An abandoned exposure remains
 * new and costs no allowance. Completed teaching enters the awaiting stage.
 */
const newWord: Rule = (q) => {
  if (q.allowanceLeft <= 0 || q.practicePolicy?.allowNew === false) {
    return null;
  }
  const carded = new Set(q.cards.map((c) => c.wordId));
  const [word] = q.words
    .filter((w) => !carded.has(w.id))
    .toSorted((a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity));
  return word ? { do: "introduce", word } : null;
};

/**
 * 3. A review due today, not rated again since this study day began.
 *
 * FSRS's one-day interval is 24 elapsed hours. On a 25-hour study day a new
 * Review due can still fall before the next rollover. Its persisted last rating
 * keeps that graduation out of today's review block, including after reopening.
 * Learning and Relearning remain governed by their minute-scale rules.
 * Due-only practice instead honors the exact due time and interleaving.
 */
const dueReview: Rule = (q) => {
  const { start, nextStart } = studyDay(q.now, q.dayRolloverHour ?? 0);
  const card = earliestDue(
    at(q, "scheduled").filter(
      (c) =>
        c.fsrs.state === State.Review &&
        (q.practicePolicy?.dueOnly
          ? c.fsrs.due <= q.now && c.wordId !== q.justShownId
          : c.fsrs.due < nextStart &&
            (c.fsrs.last_review === undefined || c.fsrs.last_review < start))
    )
  );
  return card ? { card, do: "recall" } : null;
};

/** 4. Legacy guessed-only words still require durable teaching. */
const needsExposure: Rule = (q) => {
  const card = earliestDue(
    at(q, "awaiting").filter((c) => c.initialRecallAt === undefined)
  );
  return card ? { card, do: "expose" } : null;
};

/** 5. First retrieval requires completed teaching and its persisted due time. */
const awaitingRecall: Rule = (q) => {
  const card = earliestDue(
    at(q, "awaiting").filter(
      (c) =>
        c.initialRecallAt !== undefined &&
        c.fsrs.due <= q.now &&
        c.wordId !== q.justShownId
    )
  );
  return card ? { card, do: "recall" } : null;
};

/**
 * 6. A rated learning card due later today. Filler, bounded on purpose.
 *
 * Pulling a card forward five minutes is nearly free. Pulling one forward from
 * three days out discards three days of earned spacing and empties tomorrow,
 * which invites doing it again until the collection drifts toward massing. Anki
 * draws the line in the same place: learn-ahead applies to learning cards, never
 * to mature reviews from future days.
 */
const learnAhead: Rule = (q) => {
  const nextStart = nextDay(q);
  const card = earliestDue(
    at(q, "scheduled").filter(
      (c) =>
        isLearning(c) &&
        c.fsrs.due < nextStart &&
        c.wordId !== q.justShownId &&
        !q.pulledForward.has(c.wordId)
    )
  );
  return card ? { card, do: "recall", pulledForward: true } : null;
};

/** 7. A lone taught word may be recalled only once its first recall is due. */
const showAnyway: Rule = (q) => {
  const card = earliestDue(
    at(q, "awaiting").filter(
      (c) => c.initialRecallAt !== undefined && c.fsrs.due <= q.now
    )
  );
  return card ? { card, do: "recall" } : null;
};

/**
 * 8. The card just answered, come due again, when there is nothing else at all.
 *
 * Rule 7's twin on the other side of a rating. Rule 1 refuses the card just
 * answered so that anything else goes between a failure and its return — but
 * when nothing else exists, refusing would end the session with a card due,
 * and the session never waits in either direction. If every other rule came up
 * empty, the only due card left is the excluded one, so no exclusion is needed
 * here.
 */
const dueEvenIfJustShown: Rule = (q) => {
  const card = earliestDue(
    at(q, "scheduled").filter(
      (c) => (isLearning(c) || q.practicePolicy?.dueOnly) && c.fsrs.due <= q.now
    )
  );
  return card ? { card, do: "recall" } : null;
};

/**
 * The next-card rule, in order. The session never makes the user wait — every
 * gap it can honestly fill, it fills — but when nothing is due right now it
 * says so instead of manufacturing an ending: caught up, next card at such a
 * time. "Done" is reserved for the truth it claims: nothing more within today.
 *
 * Precedence is this array. It used to be the order of the branches inside one
 * function, interleaved with the derivations they depended on, which is why the
 * learning design's numbered list and the code could disagree without anyone noticing.
 */
export const RULE: readonly Rule[] = [
  dueLearning,
  newWord,
  dueReview,
  needsExposure,
  awaitingRecall,
  learnAhead,
  showAnyway,
  dueEvenIfJustShown,
];

// Due-only practice prioritizes real recalls without bypassing interleaving.
const DUE_ONLY_RULE: readonly Rule[] = [
  dueLearning,
  awaitingRecall,
  dueReview,
  newWord,
  needsExposure,
  showAnyway,
  dueEvenIfJustShown,
];

export const pickNext = (queue: Queue): Slot => {
  const rules = queue.practicePolicy?.dueOnly ? DUE_ONLY_RULE : RULE;
  for (const rule of rules) {
    const slot = rule(queue);
    if (slot) {
      return slot;
    }
  }

  // Bounded practice reports the next real due time, even beyond today.
  // Without a policy, preserve the existing study-day completion boundary.
  const upcoming = earliestDue(
    queue.cards.filter(
      (c) =>
        ((stageOf(c) === "scheduled" &&
          (queue.practicePolicy !== undefined || isLearning(c))) ||
          (stageOf(c) === "awaiting" && c.initialRecallAt !== undefined)) &&
        c.fsrs.due > queue.now &&
        (queue.practicePolicy !== undefined || c.fsrs.due < nextDay(queue))
    )
  );
  return upcoming ? { do: "wait", until: upcoming.fsrs.due } : { do: "done" };
};

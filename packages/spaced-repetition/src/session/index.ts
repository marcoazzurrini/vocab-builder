import { createEmptyCard, fsrs } from "ts-fsrs";
import type { FSRS } from "ts-fsrs";

import { validateAnswerText } from "../lib/commands";
import { effortsFor, gradeRecall } from "./grading";
import { pickNext } from "./queue";
import { transition } from "./transition";
import type {
  Attempt,
  Card,
  Effort,
  Prompt,
  SessionStats,
  SessionView,
  Word,
} from "./types";

export type {
  Attempt,
  Card,
  Effort,
  Prompt,
  SessionStats,
  SessionView,
  Word,
} from "./types";

/** An answer and its derived card are accepted together, never as separate notifications. */
export interface AnswerChange {
  attempt: Attempt;
  card: Card | null;
}
export interface SessionOptions {
  words: Word[];
  cards: Card[];
  newPerDay: number;
  introducedToday?: number;
  dayRolloverHour?: number;
  /** Synchronously accept the complete change or throw without accepting it. */
  accept?: (change: AnswerChange) => void;
  clock?: () => Date;
  scheduler?: FSRS;
}

export interface Session {
  readonly view: SessionView;
  submitGuess: (typed: string) => void;
  exposureDone: () => void;
  submitRecall: (typed: string, effort: Effort) => void;
  dismissFeedback: () => void;
}

interface Current {
  card: Card;
  word: Word;
}
type PromptPhase = "guess" | "exposure" | "recall";
type Flow =
  | { [P in PromptPhase]: { phase: P; current: Current } }[PromptPhase]
  | { phase: "feedback"; current: Current; typed: string }
  | { phase: "caughtUp"; until: Date }
  | { phase: "done" };

interface SessionState {
  flow: Flow;
  cards: Card[];
  allowanceLeft: number;
  promptShownAt: Date;
  justShownId?: string;
  exposed: Set<string>;
  pulledForward: Set<string>;
  stats: SessionStats;
}

type Action =
  | { type: "guess"; typed: string }
  | { type: "exposure" }
  | { type: "recall"; typed: string; effort: Effort }
  | { type: "feedback" };

const promptOf = (word: Word): Prompt => ({
  gloss: word.gloss,
  hint: word.hint,
  image: word.image,
  kind: word.kind,
});

const current = (
  draft: SessionState,
  expected: PromptPhase | "feedback"
): Current => {
  const { flow } = draft;
  if (
    flow.phase === "done" ||
    flow.phase === "caughtUp" ||
    flow.phase !== expected
  ) {
    throw new Error(
      `expected phase "${expected}", session is in "${flow.phase}"`
    );
  }
  return flow.current;
};

/**
 * Each action builds a private candidate. Validation, scheduling, queue selection,
 * and acceptance must all succeed before a single assignment publishes that state.
 * A rejected action therefore cannot spend allowance, rate a card, or change phase.
 */
export const createSession = (options: SessionOptions): Session => {
  const clock = options.clock ?? (() => new Date());
  const scheduler = options.scheduler ?? fsrs({ enable_short_term: true });
  const words = structuredClone(options.words);
  const wordById = new Map(words.map((word) => [word.id, word]));
  let processing = false;

  const readClock = (): Date => {
    const now = new Date(clock());
    if (!Number.isFinite(now.getTime())) {
      // oxlint-disable-next-line unicorn/prefer-type-error -- Preserve the existing Error category for invalid session clocks.
      throw new Error("The session clock returned an invalid date.");
    }
    return now;
  };

  const advance = (draft: SessionState, now: Date): void => {
    draft.cards = draft.cards.filter((card) => wordById.has(card.wordId));
    const slot = pickNext({
      allowanceLeft: draft.allowanceLeft,
      cards: draft.cards,
      dayRolloverHour: options.dayRolloverHour,
      exposed: draft.exposed,
      justShownId: draft.justShownId,
      now,
      pulledForward: draft.pulledForward,
      words,
    });
    draft.promptShownAt = now;
    switch (slot.do) {
      case "done": {
        draft.flow = { phase: "done" };
        return;
      }
      case "wait": {
        draft.flow = { phase: "caughtUp", until: slot.until };
        return;
      }
      case "introduce": {
        draft.justShownId = slot.word.id;
        draft.flow = {
          current: {
            card: { fsrs: createEmptyCard(now), wordId: slot.word.id },
            word: slot.word,
          },
          phase: "guess",
        };
        return;
      }
      case "expose":
      case "recall": {
        if (slot.do === "recall" && slot.pulledForward) {
          draft.pulledForward.add(slot.card.wordId);
        }
        const word = wordById.get(slot.card.wordId);
        if (!word) {
          throw new Error(`No word for selected card ${slot.card.wordId}.`);
        }
        draft.justShownId = slot.card.wordId;
        draft.flow = {
          current: { card: slot.card, word },
          phase: slot.do === "expose" ? "exposure" : "recall",
        };
      }
      // Slot is an exhaustive discriminated union.
      // no default
    }
  };

  const startedAt = readClock();
  let state: SessionState = {
    allowanceLeft: Math.max(
      0,
      options.newPerDay - (options.introducedToday ?? 0)
    ),
    cards: structuredClone(options.cards),
    exposed: new Set(),
    flow: { phase: "done" },
    promptShownAt: startedAt,
    pulledForward: new Set(),
    stats: { correct: 0, introduced: 0, recalls: 0, wrong: 0 },
  };
  advance(state, startedAt);

  const apply = (
    draft: SessionState,
    action: Action,
    now: Date
  ): AnswerChange | undefined => {
    const { card, word } = current(draft, action.type);
    if (action.type === "guess" || action.type === "recall") {
      validateAnswerText(action.typed);
    }
    const latencyMs = Math.min(
      Math.max(0, now.getTime() - draft.promptShownAt.getTime()),
      86_400_000
    );
    switch (action.type) {
      case "guess": {
        const result = transition(
          card.fsrs,
          word.text,
          { phase: "guess", rating: null, typed: action.typed },
          now,
          scheduler
        );
        const change: AnswerChange = {
          attempt: {
            correct: result.correct,
            latencyMs,
            phase: "guess",
            rating: null,
            reviewedAt: now,
            stateBefore: card.fsrs,
            typed: action.typed,
            wordId: card.wordId,
          },
          card: null,
        };
        // The guess, not merely displaying a prompt, introduces this word.
        card.fsrs = createEmptyCard(now);
        draft.cards.push(card);
        draft.allowanceLeft -= 1;
        draft.stats.introduced += 1;
        draft.flow = { current: { card, word }, phase: "exposure" };
        return change;
      }
      case "exposure": {
        draft.exposed.add(card.wordId);
        advance(draft, now);
        return;
      }
      case "recall": {
        const before = card.fsrs;
        const { correct, rating } = gradeRecall(
          action.typed,
          word.text,
          action.effort,
          effortsFor(before)
        );
        const { after } = transition(
          before,
          word.text,
          { phase: "recall", rating, typed: action.typed },
          now,
          scheduler
        );
        if (!after) {
          throw new Error("A recall must produce a schedule.");
        }
        card.fsrs = after;
        const change: AnswerChange = {
          attempt: {
            correct,
            latencyMs,
            phase: "recall",
            rating,
            reviewedAt: now,
            stateBefore: before,
            typed: action.typed,
            wordId: card.wordId,
          },
          card,
        };
        draft.stats.recalls += 1;
        if (correct) {
          draft.stats.correct += 1;
          advance(draft, now);
        } else {
          draft.stats.wrong += 1;
          draft.flow = {
            current: { card, word },
            phase: "feedback",
            typed: action.typed,
          };
        }
        return change;
      }
      case "feedback": {
        advance(draft, now);
        break;
      }
      // Action is an exhaustive discriminated union.
      // no default
    }
  };

  const dispatch = (action: Action): void => {
    if (processing) {
      throw new Error("A session action is already being processed.");
    }
    processing = true;
    try {
      const draft = structuredClone(state);
      const change = apply(draft, action, readClock());
      // The sink receives detached values. It cannot modify the candidate or
      // re-enter this session while durable acceptance is in progress.
      if (change) {
        options.accept?.(structuredClone(change));
      }
      state = draft;
    } finally {
      processing = false;
    }
  };

  return {
    dismissFeedback: () => dispatch({ type: "feedback" }),
    exposureDone: () => dispatch({ type: "exposure" }),
    submitGuess: (typed) => dispatch({ type: "guess", typed }),
    submitRecall: (typed, effort) =>
      dispatch({ effort, type: "recall", typed }),
    get view(): SessionView {
      const { flow } = state;
      switch (flow.phase) {
        case "guess": {
          return { phase: flow.phase, prompt: promptOf(flow.current.word) };
        }
        case "exposure": {
          return {
            answer: flow.current.word.text,
            phase: flow.phase,
            prompt: promptOf(flow.current.word),
          };
        }
        case "recall": {
          return {
            efforts: effortsFor(flow.current.card.fsrs),
            phase: flow.phase,
            prompt: promptOf(flow.current.word),
          };
        }
        case "feedback": {
          return {
            expected: flow.current.word.text,
            phase: flow.phase,
            typed: flow.typed,
          };
        }
        case "caughtUp": {
          return {
            nextDueAt: new Date(flow.until),
            phase: flow.phase,
            stats: { ...state.stats },
          };
        }
        case "done": {
          return { phase: flow.phase, stats: { ...state.stats } };
        }
        // Flow is an exhaustive discriminated union.
        // no default
      }
    },
  };
};

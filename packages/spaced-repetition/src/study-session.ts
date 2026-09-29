import { createEmptyCard } from "ts-fsrs";
import type { FSRS } from "ts-fsrs";

import { validateAnswerText } from "./answer-command";
import type { SessionAttempt } from "./answer-command";
import { effortsFor, gradeRecall } from "./answer-grading";
import type { Effort } from "./answer-grading";
import { toCard } from "./restore-progress";
import type { Word, EntryPresentation } from "./restore-progress";
import {
  createScheduler,
  transition,
  RevisionConflict,
} from "./review-scheduling";
import type { Card } from "./review-scheduling";
import { pickNext } from "./select-next-step";
import { initialRecallAt, teachingSchedule } from "./teaching-schedule";

/** Everything needed to pose the question, and nothing that answers it. */
export interface Prompt {
  gloss: string;
  hint: string | null;
  image: string | null;
  kind: "word" | "chunk";
  meaning?: string;
  context?: string | null;
  grammar?: string | null;
}

export interface SessionStats {
  introduced: number;
  recalls: number;
  correct: number;
  wrong: number;
}

/**
 * The entire surface the UI sees. A discriminated union rather than a phase
 * plus a bag of optional fields, so asking for the answer during the recall
 * phase is not a bug to guard against — it does not typecheck.
 */
export type SessionView =
  | {
      phase: "exposure";
      prompt: Prompt;
      answer: string;
      revealNote?: string;
      presentation?: EntryPresentation;
    }
  /** `efforts` is the list of buttons to draw. The UI holds no grading policy. */
  | { phase: "recall"; prompt: Prompt; efforts: Effort[] }
  /** Only ever reached by a wrong answer, so there is no `correct` flag. */
  | {
      phase: "feedback";
      expected: string;
      typed: string;
      revealNote?: string;
      presentation?: EntryPresentation;
    }
  /**
   * Nothing due right now, but a card is still coming today. The honest pause
   * Anki calls its congratulations screen: the user is told when, and the UI
   * rebuilds the session at that moment. `done` remains final for the day.
   */
  | { phase: "caughtUp"; nextDueAt: Date; stats: SessionStats }
  | { phase: "done"; stats: SessionStats };

/** An answer and its derived card are accepted together, never as separate notifications. */
export interface AnswerChange {
  attempt: SessionAttempt;
  card: Card | null;
}
export interface SessionEngineOptions {
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
  exposureDone: () => void;
  submitRecall: (typed: string, effort: Effort) => void;
  dismissFeedback: () => void;
}

interface Current {
  card: Card;
  word: Word;
}
type PromptPhase = "exposure" | "recall";
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
  pulledForward: Set<string>;
  stats: SessionStats;
}

type Action =
  | { type: "exposure" }
  | { type: "recall"; typed: string; effort: Effort }
  | { type: "feedback" };

const promptOf = (word: Word): Prompt => {
  const prompt: Prompt = {
    gloss: word.gloss,
    hint: word.hint,
    image: word.image,
    kind: word.kind,
  };
  if (word.presentation) {
    prompt.meaning = word.presentation.meaning;
    prompt.context = word.presentation.context;
    prompt.grammar = word.presentation.grammar;
  }
  return prompt;
};

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
export const startSession = (options: SessionEngineOptions): Session => {
  const clock = options.clock ?? (() => new Date());
  const scheduler = options.scheduler ?? createScheduler();
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
          phase: "exposure",
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
    if (action.type === "recall") {
      validateAnswerText(action.typed);
    }
    const latencyMs = Math.min(
      Math.max(0, now.getTime() - draft.promptShownAt.getTime()),
      86_400_000
    );
    switch (action.type) {
      case "exposure": {
        const due = initialRecallAt(now.toISOString());
        card.fsrs = toCard({
          schedule: teachingSchedule(due),
          wordId: card.wordId,
        }).fsrs;
        card.initialRecallAt = due;
        // A legacy guess already spent its introduction allowance.
        if (!draft.cards.some((existing) => existing.wordId === card.wordId)) {
          draft.cards.push(card);
          draft.allowanceLeft -= 1;
          draft.stats.introduced += 1;
        }
        const change: AnswerChange = {
          attempt: {
            latencyMs,
            phase: "teach",
            reviewedAt: now,
            wordId: card.wordId,
          },
          card,
        };
        advance(draft, now);
        return change;
      }
      case "recall": {
        const before = card.fsrs;
        if (before.reps === 0 && now < before.due) {
          throw new RevisionConflict();
        }
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
    submitRecall: (typed, effort) =>
      dispatch({ effort, type: "recall", typed }),
    get view(): SessionView {
      const { flow } = state;
      switch (flow.phase) {
        case "exposure": {
          const view: SessionView = {
            answer: flow.current.word.text,
            phase: flow.phase,
            prompt: promptOf(flow.current.word),
          };
          if (flow.current.word.revealNote) {
            view.revealNote = flow.current.word.revealNote;
          }
          if (flow.current.word.presentation) {
            view.presentation = structuredClone(flow.current.word.presentation);
          }
          return view;
        }
        case "recall": {
          return {
            efforts: effortsFor(flow.current.card.fsrs),
            phase: flow.phase,
            prompt: promptOf(flow.current.word),
          };
        }
        case "feedback": {
          const view: SessionView = {
            expected: flow.current.word.text,
            phase: flow.phase,
            typed: flow.typed,
          };
          if (flow.current.word.revealNote) {
            view.revealNote = flow.current.word.revealNote;
          }
          if (flow.current.word.presentation) {
            view.presentation = structuredClone(flow.current.word.presentation);
          }
          return view;
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

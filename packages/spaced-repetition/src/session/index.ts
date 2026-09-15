import { createEmptyCard, fsrs } from "ts-fsrs";
import type { FSRS } from "ts-fsrs";
import { validateAnswerText } from "../lib/commands";
import { effortsFor, gradeRecall } from "./grading";
import { transition } from "./transition";
import { pickNext } from "./queue";
import type { Attempt, Card, Effort, Prompt, SessionStats, SessionView, Word } from "./types";

export type { Attempt, Card, Effort, Prompt, SessionStats, SessionView, Word };

/** An answer and its derived card are accepted together, never as separate notifications. */
export type AnswerChange = { attempt: Attempt; card: Card | null };
export type SessionOptions = {
  words: Word[];
  cards: Card[];
  newPerDay: number;
  introducedToday?: number;
  dayRolloverHour?: number;
  /** Synchronously accept the complete change or throw without accepting it. */
  accept?: (change: AnswerChange) => void;
  clock?: () => Date;
  scheduler?: FSRS;
};

export type Session = {
  readonly view: SessionView;
  submitGuess(typed: string): void;
  exposureDone(): void;
  submitRecall(typed: string, effort: Effort): void;
  dismissFeedback(): void;
};

type Current = { card: Card; word: Word };
type PromptPhase = "guess" | "exposure" | "recall";
type Flow =
  | { [P in PromptPhase]: { phase: P; current: Current } }[PromptPhase]
  | { phase: "feedback"; current: Current; typed: string }
  | { phase: "caughtUp"; until: Date }
  | { phase: "done" };

type SessionState = {
  flow: Flow;
  cards: Card[];
  allowanceLeft: number;
  promptShownAt: Date;
  justShownId?: string;
  exposed: Set<string>;
  pulledForward: Set<string>;
  stats: SessionStats;
};

type Action =
  | { type: "guess"; typed: string }
  | { type: "exposure" }
  | { type: "recall"; typed: string; effort: Effort }
  | { type: "feedback" };

function promptOf(word: Word): Prompt {
  return { gloss: word.gloss, hint: word.hint, image: word.image, kind: word.kind };
}

/**
 * Each action builds a private candidate. Validation, scheduling, queue selection,
 * and acceptance must all succeed before a single assignment publishes that state.
 * A rejected action therefore cannot spend allowance, rate a card, or change phase.
 */
export function createSession(options: SessionOptions): Session {
  const clock = options.clock ?? (() => new Date());
  const scheduler = options.scheduler ?? fsrs({ enable_short_term: true });
  const words = structuredClone(options.words);
  const wordById = new Map(words.map((word) => [word.id, word]));
  let processing = false;

  function readClock(): Date {
    const now = new Date(clock());
    if (!Number.isFinite(now.getTime()))
      throw new Error("The session clock returned an invalid date.");
    return now;
  }

  function advance(draft: SessionState, now: Date): void {
    draft.cards = draft.cards.filter((card) => wordById.has(card.wordId));
    const slot = pickNext({
      cards: draft.cards,
      words,
      now,
      allowanceLeft: draft.allowanceLeft,
      exposed: draft.exposed,
      pulledForward: draft.pulledForward,
      justShownId: draft.justShownId,
      dayRolloverHour: options.dayRolloverHour,
    });
    draft.promptShownAt = now;
    switch (slot.do) {
      case "done":
        draft.flow = { phase: "done" };
        return;
      case "wait":
        draft.flow = { phase: "caughtUp", until: slot.until };
        return;
      case "introduce":
        draft.justShownId = slot.word.id;
        draft.flow = {
          phase: "guess",
          current: { card: { wordId: slot.word.id, fsrs: createEmptyCard(now) }, word: slot.word },
        };
        return;
      case "expose":
      case "recall":
        if (slot.do === "recall" && slot.pulledForward) draft.pulledForward.add(slot.card.wordId);
        draft.justShownId = slot.card.wordId;
        draft.flow = {
          phase: slot.do === "expose" ? "exposure" : "recall",
          current: { card: slot.card, word: wordById.get(slot.card.wordId)! },
        };
    }
  }

  function current(draft: SessionState, expected: PromptPhase | "feedback"): Current {
    const flow = draft.flow;
    if (flow.phase === "done" || flow.phase === "caughtUp" || flow.phase !== expected)
      throw new Error(`expected phase "${expected}", session is in "${flow.phase}"`);
    return flow.current;
  }

  const now = readClock();
  let state: SessionState = {
    flow: { phase: "done" },
    cards: structuredClone(options.cards),
    allowanceLeft: Math.max(0, options.newPerDay - (options.introducedToday ?? 0)),
    promptShownAt: now,
    exposed: new Set(),
    pulledForward: new Set(),
    stats: { introduced: 0, recalls: 0, correct: 0, wrong: 0 },
  };
  advance(state, now);

  function apply(draft: SessionState, action: Action, now: Date): AnswerChange | undefined {
    const { card, word } = current(draft, action.type);
    if (action.type === "guess" || action.type === "recall") validateAnswerText(action.typed);
    const latencyMs = Math.min(
      Math.max(0, now.getTime() - draft.promptShownAt.getTime()),
      86_400_000,
    );
    switch (action.type) {
      case "guess": {
        const result = transition(
          card.fsrs,
          word.text,
          { typed: action.typed, phase: "guess", rating: null },
          now,
          scheduler,
        );
        const change: AnswerChange = {
          card: null,
          attempt: {
            wordId: card.wordId,
            phase: "guess",
            typed: action.typed,
            correct: result.correct,
            rating: null,
            latencyMs,
            stateBefore: card.fsrs,
            reviewedAt: now,
          },
        };
        // The guess, not merely displaying a prompt, introduces this word.
        card.fsrs = createEmptyCard(now);
        draft.cards.push(card);
        draft.allowanceLeft -= 1;
        draft.stats.introduced += 1;
        draft.flow = { phase: "exposure", current: { card, word } };
        return change;
      }
      case "exposure":
        draft.exposed.add(card.wordId);
        advance(draft, now);
        return;
      case "recall": {
        const before = card.fsrs;
        const { correct, rating } = gradeRecall(
          action.typed,
          word.text,
          action.effort,
          effortsFor(before),
        );
        card.fsrs = transition(
          before,
          word.text,
          { typed: action.typed, phase: "recall", rating },
          now,
          scheduler,
        ).after!;
        const change: AnswerChange = {
          card,
          attempt: {
            wordId: card.wordId,
            phase: "recall",
            typed: action.typed,
            correct,
            rating,
            latencyMs,
            stateBefore: before,
            reviewedAt: now,
          },
        };
        draft.stats.recalls += 1;
        if (correct) {
          draft.stats.correct += 1;
          advance(draft, now);
        } else {
          draft.stats.wrong += 1;
          draft.flow = { phase: "feedback", current: { card, word }, typed: action.typed };
        }
        return change;
      }
      case "feedback":
        advance(draft, now);
        return;
    }
  }

  function dispatch(action: Action): void {
    if (processing) throw new Error("A session action is already being processed.");
    processing = true;
    try {
      const draft = structuredClone(state);
      const change = apply(draft, action, readClock());
      // The sink receives detached values. It cannot modify the candidate or
      // re-enter this session while durable acceptance is in progress.
      if (change) options.accept?.(structuredClone(change));
      state = draft;
    } finally {
      processing = false;
    }
  }

  return {
    get view(): SessionView {
      const flow = state.flow;
      switch (flow.phase) {
        case "guess":
          return { phase: flow.phase, prompt: promptOf(flow.current.word) };
        case "exposure":
          return {
            phase: flow.phase,
            prompt: promptOf(flow.current.word),
            answer: flow.current.word.text,
          };
        case "recall":
          return {
            phase: flow.phase,
            prompt: promptOf(flow.current.word),
            efforts: effortsFor(flow.current.card.fsrs),
          };
        case "feedback":
          return { phase: flow.phase, expected: flow.current.word.text, typed: flow.typed };
        case "caughtUp":
          return { phase: flow.phase, nextDueAt: new Date(flow.until), stats: { ...state.stats } };
        case "done":
          return { phase: flow.phase, stats: { ...state.stats } };
      }
    },
    submitGuess: (typed) => dispatch({ type: "guess", typed }),
    exposureDone: () => dispatch({ type: "exposure" }),
    submitRecall: (typed, effort) => dispatch({ type: "recall", typed, effort }),
    dismissFeedback: () => dispatch({ type: "feedback" }),
  };
}

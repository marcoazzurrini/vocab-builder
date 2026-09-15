/** Test-only learner using the same JSON commands and snapshots as the app. */
import { State } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";

import { createSession } from "../index";
import type { AnswerCommand, ReviewSnapshot, SessionView } from "../index";
import { evaluateAnswer } from "../server";
import type { Attempt, Effort, Word } from "./types";

/** Independent facts at selection time, not the production queue's decision. */
export interface Eligibility {
  eligibleWordIds: string[];
  remainingLearning: { wordId: string; due: number }[];
}

type PromptFacts = Eligibility & {
  word: string;
  wordId: string;
  shownAt: number;
  actedAt: number;
};
interface AnswerFacts {
  typed: string;
  correct: boolean;
  expectedReps: number;
}
export type Step =
  | (PromptFacts & AnswerFacts & { at: "guess" })
  | (PromptFacts & { at: "exposure" })
  | (PromptFacts &
      AnswerFacts & { at: "recall"; first: boolean; effort: Effort })
  | (PromptFacts & { at: "feedback" })
  | (Eligibility & {
      at: "closed";
      reason: "done" | "caughtUp" | "cut";
      atMs: number;
      nextDueAt: number | null;
    });

export interface Behaviour {
  /** Pretests are unrated whether the learner already knows the word or not. */
  guessCorrect?: (word: Word) => boolean;
  correct?: (word: Word, recallNumber: number) => boolean;
  effort?: (word: Word) => Effort;
  msPerPrompt?: number | (() => number);
}

export interface Learner {
  /** With no cap, throw rather than hang if a sitting never ends. */
  sit: (maxSteps?: number) => Step[];
  wait: (ms: number) => void;
  readonly now: Date;
  readonly trace: readonly Step[];
  readonly attempts: readonly Attempt[];
  readonly commands: readonly AnswerCommand[];
  readonly snapshot: ReviewSnapshot;
  readonly cardedWordIds: readonly string[];
  readonly introducedToday: number;
}

interface StudyBounds {
  start: number;
  end: number;
}

type PromptView = Exclude<SessionView, { phase: "done" | "caughtUp" }>;

const validatePrompt = (word: Word, view: PromptView): void => {
  if (view.phase !== "feedback") {
    for (const key of ["hint", "image", "kind"] as const) {
      if (view.prompt[key] !== word[key]) {
        throw new Error(`${word.id}: prompt ${key} differs`);
      }
    }
    if (view.phase === "exposure" && view.answer !== word.text) {
      throw new Error(`${word.id}: exposure shows the wrong answer`);
    }
  }
};

const isPaceFunction = (pace: number | (() => number)): pace is () => number =>
  typeof pace === "function";

/** Calendar arithmetic stays device-local, including DST and non-midnight days. */
export const studyBounds = (at: number, rollover: number): StudyBounds => {
  const local = new Date(at);
  // Construct each boundary separately: a missing DST hour must not shift
  // tomorrow's rollover (or yesterday's) to the normalized hour.
  const boundary = (offset: number) =>
    new Date(
      local.getFullYear(),
      local.getMonth(),
      local.getDate() + offset,
      rollover
    ).getTime();
  const offset = boundary(0) > at ? -1 : 0;
  return { end: boundary(offset + 1) - 1, start: boundary(offset) };
};

// oxlint-disable-next-line unicorn/prefer-structured-clone -- Model the JSON wire contract: stringify dates and omit undefined properties.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Reconstruct the audit row from the server result, never internal callbacks. */
const scheduleFromJSON = (schedule: string): FsrsCard => {
  const stored = JSON.parse(schedule);
  const card = { ...stored, due: new Date(stored.due) };
  if (stored.last_review) {
    card.last_review = new Date(stored.last_review);
  }
  return card;
};

export const createLearner = (options: {
  words: Word[];
  newPerDay: number;
  start: Date;
  behaviour?: Behaviour;
  dayRolloverHour?: number;
}): Learner => {
  const { words, newPerDay, start } = options;
  const rollover = options.dayRolloverHour ?? 0;
  const correct = options.behaviour?.correct ?? (() => true);
  const effort = options.behaviour?.effort ?? (() => "good" as const);
  const pace = options.behaviour?.msPerPrompt ?? 18_000;
  const byGloss = new Map<string, Word>();
  const byText = new Map<string, Word>();
  const byId = new Map<string, Word>();
  for (const word of words) {
    if (byGloss.has(word.gloss)) {
      throw new Error(`two words share the gloss "${word.gloss}"`);
    }
    if (byText.has(word.text)) {
      throw new Error(`two words share the text "${word.text}"`);
    }
    if (byId.has(word.id)) {
      throw new Error(`two words share the id "${word.id}"`);
    }
    byGloss.set(word.gloss, word);
    byText.set(word.text, word);
    byId.set(word.id, word);
  }

  const cardRows = new Map<string, string>();
  const commands: AnswerCommand[] = [];
  const attempts: Attempt[] = [];
  const trace: Step[] = [];
  const recallCount = new Map<string, number>();
  let nowMs = start.getTime();
  const guessRows = () =>
    commands
      .filter((c) => c.phase === "guess")
      .map(({ wordId, reviewedAt }) => ({ reviewedAt, wordId }));
  const introducedToday = () => {
    const boundary = studyBounds(nowMs, rollover).start;
    return guessRows().filter((g) => Date.parse(g.reviewedAt) >= boundary)
      .length;
  };
  const snapshot = (): ReviewSnapshot =>
    json({
      cards: [...cardRows].map(([wordId, schedule]) => ({ schedule, wordId })),
      guesses: guessRows(),
      words,
    });

  const sit = (maxSteps?: number): Step[] => {
    const pulled = new Set<string>();
    let allowance = Math.max(0, newPerDay - introducedToday());
    let justShownId: string | undefined;

    // This is a set of admissible work, not a copy of queue priority rules.
    const eligibility = (): Eligibility => {
      const { start: studyStart, end } = studyBounds(nowMs, rollover);
      const guessed = new Set(guessRows().map((g) => g.wordId));
      const eligibleWordIds: string[] = [];
      const remainingLearning: Eligibility["remainingLearning"] = [];
      for (const word of words) {
        const row = cardRows.get(word.id);
        if (!row) {
          if (guessed.has(word.id) || allowance > 0) {
            eligibleWordIds.push(word.id);
          }
          continue;
        }
        const card = scheduleFromJSON(row);
        const due = card.due.getTime();
        if (card.state === State.Review) {
          const ratedToday =
            (card.last_review?.getTime() ?? -Infinity) >= studyStart;
          if (due <= end && !ratedToday) {
            eligibleWordIds.push(word.id);
          }
        } else {
          if (due > nowMs && due <= end) {
            remainingLearning.push({ due, wordId: word.id });
          }
          if (
            due <= nowMs ||
            (due <= end && !pulled.has(word.id) && word.id !== justShownId)
          ) {
            eligibleWordIds.push(word.id);
          }
        }
      }
      return { eligibleWordIds, remainingLearning };
    };

    const session = createSession({
      acceptAnswer: (raw) => {
        const command = json(raw);
        const word = byId.get(command.wordId);
        if (!word) {
          throw new Error(`unknown word in answer ${command.wordId}`);
        }
        const result = evaluateAnswer(
          command,
          word.text,
          cardRows.get(command.wordId),
          new Date(nowMs)
        );
        // Commit only JSON data after durable acceptance succeeds.
        commands.push(command);
        if (result.nextSchedule !== null) {
          cardRows.set(command.wordId, result.nextSchedule);
        }
        attempts.push({
          correct: result.correct,
          latencyMs: command.latencyMs,
          phase: command.phase,
          rating: command.rating,
          reviewedAt: new Date(command.reviewedAt),
          stateBefore: scheduleFromJSON(result.previousSchedule),
          typed: command.typed,
          wordId: command.wordId,
        });
      },
      clock: () => new Date(nowMs),
      settings: { dayRolloverHour: rollover, lang: "fr", newPerDay },
      snapshot: snapshot(),
    });

    const steps: Step[] = [];
    const act = (
      view: PromptView,
      word: Word,
      base: PromptFacts,
      reps: number
    ): void => {
      if (view.phase === "guess") {
        const right = options.behaviour?.guessCorrect?.(word) ?? false;
        const typed = right ? word.text : "";
        steps.push({
          ...base,
          at: "guess",
          correct: right,
          expectedReps: 0,
          typed,
        });
        session.submitGuess(typed);
        allowance -= 1;
      } else if (view.phase === "exposure") {
        steps.push({ ...base, at: "exposure" });
        session.exposureDone();
      } else if (view.phase === "recall") {
        const n = (recallCount.get(word.id) ?? 0) + 1;
        recallCount.set(word.id, n);
        const right = correct(word, n);
        const typed = right ? word.text : `${word.text}-sbagliato`;
        const chosen = effort(word);
        steps.push({
          ...base,
          at: "recall",
          correct: right,
          effort: chosen,
          expectedReps: reps,
          first: reps === 0,
          typed,
        });
        session.submitRecall(typed, chosen);
      } else {
        steps.push({ ...base, at: "feedback" });
        session.dismissFeedback();
      }
    };
    const limit = maxSteps ?? 5000;
    let facts = eligibility();
    let shownAt = nowMs;
    for (let i = 0; i < limit; i += 1) {
      const { view } = session;
      if (view.phase === "done" || view.phase === "caughtUp") {
        break;
      }
      const word =
        view.phase === "feedback"
          ? byText.get(view.expected)
          : byGloss.get(view.prompt.gloss);
      if (!word) {
        throw new Error(`unknown word on ${view.phase} screen`);
      }
      validatePrompt(word, view);
      const reps = commands.filter(
        (c) => c.wordId === word.id && c.phase === "recall"
      ).length;
      if (view.phase === "recall") {
        const row = cardRows.get(word.id);
        if (row) {
          const before = scheduleFromJSON(row);
          if (before.state !== State.Review && before.due.getTime() > shownAt) {
            pulled.add(word.id);
          }
        }
      }
      justShownId = word.id;
      // Thinking belongs to this action, not the next prompt.
      nowMs += isPaceFunction(pace) ? pace() : pace;
      const base: PromptFacts = {
        ...facts,
        actedAt: nowMs,
        shownAt,
        word: word.text,
        wordId: word.id,
      };
      act(view, word, base, reps);
      facts = eligibility();
      shownAt = nowMs;
    }

    const { view } = session;
    const reason =
      view.phase === "done" || view.phase === "caughtUp" ? view.phase : "cut";
    if (maxSteps === undefined && reason === "cut") {
      throw new Error(`session was still going after ${limit} prompts`);
    }
    steps.push({
      ...facts,
      at: "closed",
      atMs: nowMs,
      nextDueAt: view.phase === "caughtUp" ? view.nextDueAt.getTime() : null,
      reason,
    });
    trace.push(...steps);
    return steps;
  };

  return {
    get attempts() {
      return attempts;
    },
    get cardedWordIds() {
      return [...cardRows.keys()];
    },
    get commands() {
      return commands;
    },
    get introducedToday() {
      return introducedToday();
    },
    get now() {
      return new Date(nowMs);
    },
    sit,
    get snapshot() {
      return snapshot();
    },
    get trace() {
      return trace;
    },
    wait: (ms) => {
      nowMs += ms;
    },
  };
};

/** Distinct, frequency-ordered words; optional metadata exercises the public prompt. */
export const catalogue = (n: number): Word[] =>
  Array.from({ length: n }, (_, i) => ({
    freqRank: i,
    gloss: `parola${i}`,
    hint: i % 2 ? `hint ${i}` : null,
    id: `w${i}`,
    image: i % 3 ? null : `https://example.test/word-${i}.png`,
    kind: i % 2 ? "chunk" : "word",
    text: `mot${i}`,
  }));

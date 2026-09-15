/** Test-only learner using the same JSON commands and snapshots as the app. */
import { State } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";
import { createSession } from "../index";
import type { AnswerCommand, ReviewSnapshot } from "../index";
import { evaluateAnswer } from "../server";
import type { Attempt, Effort, Word } from "./types";

/** Independent facts at selection time, not the production queue's decision. */
export type Eligibility = {
  eligibleWordIds: string[];
  remainingLearning: { wordId: string; due: number }[];
};

type PromptFacts = Eligibility & {
  word: string;
  wordId: string;
  shownAt: number;
  actedAt: number;
};
type AnswerFacts = { typed: string; correct: boolean; expectedReps: number };
export type Step =
  | (PromptFacts & AnswerFacts & { at: "guess" })
  | (PromptFacts & { at: "exposure" })
  | (PromptFacts & AnswerFacts & { at: "recall"; first: boolean; effort: Effort })
  | (PromptFacts & { at: "feedback" })
  | (Eligibility & {
      at: "closed";
      reason: "done" | "caughtUp" | "cut";
      atMs: number;
      nextDueAt: number | null;
    });

export type Behaviour = {
  /** Pretests are unrated whether the learner already knows the word or not. */
  guessCorrect?: (word: Word) => boolean;
  correct?: (word: Word, recallNumber: number) => boolean;
  effort?: (word: Word) => Effort;
  msPerPrompt?: number | (() => number);
};

export type Learner = {
  /** With no cap, throw rather than hang if a sitting never ends. */
  sit(maxSteps?: number): Step[];
  wait(ms: number): void;
  readonly now: Date;
  readonly trace: readonly Step[];
  readonly attempts: readonly Attempt[];
  readonly commands: readonly AnswerCommand[];
  readonly snapshot: ReviewSnapshot;
  readonly cardedWordIds: readonly string[];
  readonly introducedToday: number;
};

/** Calendar arithmetic stays device-local, including DST and non-midnight days. */
export function studyBounds(at: number, rollover: number): { start: number; end: number } {
  const local = new Date(at);
  // Construct each boundary separately: a missing DST hour must not shift
  // tomorrow's rollover (or yesterday's) to the normalized hour.
  const boundary = (offset: number) =>
    new Date(local.getFullYear(), local.getMonth(), local.getDate() + offset, rollover).getTime();
  const offset = boundary(0) > at ? -1 : 0;
  return { start: boundary(offset), end: boundary(offset + 1) - 1 };
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Reconstruct the audit row from the server result, never internal callbacks. */
function scheduleFromJSON(schedule: string): FsrsCard {
  const stored = JSON.parse(schedule);
  return {
    ...stored,
    due: new Date(stored.due),
    ...(stored.last_review ? { last_review: new Date(stored.last_review) } : {}),
  };
}

export function createLearner(options: {
  words: Word[];
  newPerDay: number;
  start: Date;
  behaviour?: Behaviour;
  dayRolloverHour?: number;
}): Learner {
  const { words, newPerDay, start } = options;
  const rollover = options.dayRolloverHour ?? 0;
  const correct = options.behaviour?.correct ?? (() => true);
  const effort = options.behaviour?.effort ?? (() => "good" as const);
  const pace = options.behaviour?.msPerPrompt ?? 18_000;
  const byGloss = new Map<string, Word>();
  const byText = new Map<string, Word>();
  const byId = new Map<string, Word>();
  for (const word of words) {
    if (byGloss.has(word.gloss)) throw new Error(`two words share the gloss "${word.gloss}"`);
    if (byText.has(word.text)) throw new Error(`two words share the text "${word.text}"`);
    if (byId.has(word.id)) throw new Error(`two words share the id "${word.id}"`);
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
      .map(({ wordId, reviewedAt }) => ({ wordId, reviewedAt }));
  const introducedToday = () => {
    const boundary = studyBounds(nowMs, rollover).start;
    return guessRows().filter((g) => Date.parse(g.reviewedAt) >= boundary).length;
  };
  const snapshot = (): ReviewSnapshot =>
    json({
      words,
      cards: [...cardRows].map(([wordId, schedule]) => ({ wordId, schedule })),
      guesses: guessRows(),
    });

  function sit(maxSteps?: number): Step[] {
    const pulled = new Set<string>();
    let allowance = Math.max(0, newPerDay - introducedToday());
    let justShownId: string | undefined;

    // This is a set of admissible work, not a copy of queue priority rules.
    function eligibility(): Eligibility {
      const end = studyBounds(nowMs, rollover).end;
      const guessed = new Set(guessRows().map((g) => g.wordId));
      const eligibleWordIds: string[] = [];
      const remainingLearning: Eligibility["remainingLearning"] = [];
      for (const word of words) {
        const row = cardRows.get(word.id);
        if (!row) {
          if (guessed.has(word.id) || allowance > 0) eligibleWordIds.push(word.id);
          continue;
        }
        const card = scheduleFromJSON(row);
        const due = card.due.getTime();
        if (card.state === State.Review) {
          if (due <= end) eligibleWordIds.push(word.id);
        } else {
          if (due > nowMs && due <= end) remainingLearning.push({ wordId: word.id, due });
          if (due <= nowMs || (due <= end && !pulled.has(word.id) && word.id !== justShownId)) {
            eligibleWordIds.push(word.id);
          }
        }
      }
      return { eligibleWordIds, remainingLearning };
    }

    const session = createSession({
      snapshot: snapshot(),
      settings: { lang: "fr", newPerDay, dayRolloverHour: rollover },
      clock: () => new Date(nowMs),
      acceptAnswer: (raw) => {
        const command = json(raw);
        const result = evaluateAnswer(
          command,
          byId.get(command.wordId)!.text,
          cardRows.get(command.wordId),
          new Date(nowMs),
        );
        // Commit only JSON data after durable acceptance succeeds.
        commands.push(command);
        if (result.nextSchedule !== null) cardRows.set(command.wordId, result.nextSchedule);
        attempts.push({
          wordId: command.wordId,
          phase: command.phase,
          typed: command.typed,
          rating: command.rating,
          latencyMs: command.latencyMs,
          correct: result.correct,
          reviewedAt: new Date(command.reviewedAt),
          stateBefore: scheduleFromJSON(result.previousSchedule),
        });
      },
    });

    const steps: Step[] = [];
    const limit = maxSteps ?? 5_000;
    let facts = eligibility();
    let shownAt = nowMs;
    for (let i = 0; i < limit; i++) {
      const view = session.view;
      if (view.phase === "done" || view.phase === "caughtUp") break;
      const word =
        view.phase === "feedback" ? byText.get(view.expected)! : byGloss.get(view.prompt.gloss)!;
      if (!word) throw new Error(`unknown word on ${view.phase} screen`);
      if (view.phase !== "feedback") {
        for (const key of ["hint", "image", "kind"] as const) {
          if (view.prompt[key] !== word[key]) throw new Error(`${word.id}: prompt ${key} differs`);
        }
        if (view.phase === "exposure" && view.answer !== word.text) {
          throw new Error(`${word.id}: exposure shows the wrong answer`);
        }
      }
      const reps = commands.filter((c) => c.wordId === word.id && c.phase === "recall").length;
      if (view.phase === "recall") {
        const row = cardRows.get(word.id);
        if (row) {
          const before = scheduleFromJSON(row);
          if (before.state !== State.Review && before.due.getTime() > shownAt) pulled.add(word.id);
        }
      }
      justShownId = word.id;
      // Thinking belongs to this action, not the next prompt.
      nowMs += typeof pace === "function" ? pace() : pace;
      const base: PromptFacts = {
        ...facts,
        word: word.text,
        wordId: word.id,
        shownAt,
        actedAt: nowMs,
      };
      if (view.phase === "guess") {
        const right = options.behaviour?.guessCorrect?.(word) ?? false;
        const typed = right ? word.text : "";
        steps.push({ ...base, at: "guess", typed, correct: right, expectedReps: 0 });
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
          first: reps === 0,
          expectedReps: reps,
          typed,
          correct: right,
          effort: chosen,
        });
        session.submitRecall(typed, chosen);
      } else {
        steps.push({ ...base, at: "feedback" });
        session.dismissFeedback();
      }
      facts = eligibility();
      shownAt = nowMs;
    }

    const view = session.view;
    const reason = view.phase === "done" || view.phase === "caughtUp" ? view.phase : "cut";
    if (maxSteps === undefined && reason === "cut") {
      throw new Error(`session was still going after ${limit} prompts`);
    }
    steps.push({
      ...facts,
      at: "closed",
      reason,
      atMs: nowMs,
      nextDueAt: view.phase === "caughtUp" ? view.nextDueAt.getTime() : null,
    });
    trace.push(...steps);
    return steps;
  }

  return {
    sit,
    wait: (ms) => {
      nowMs += ms;
    },
    get now() {
      return new Date(nowMs);
    },
    get trace() {
      return trace;
    },
    get attempts() {
      return attempts;
    },
    get commands() {
      return commands;
    },
    get snapshot() {
      return snapshot();
    },
    get cardedWordIds() {
      return [...cardRows.keys()];
    },
    get introducedToday() {
      return introducedToday();
    },
  };
}

/** Distinct, frequency-ordered words; optional metadata exercises the public prompt. */
export function catalogue(n: number): Word[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    text: `mot${i}`,
    gloss: `parola${i}`,
    hint: i % 2 ? `hint ${i}` : null,
    image: i % 3 ? null : `https://example.test/word-${i}.png`,
    kind: i % 2 ? "chunk" : "word",
    freqRank: i,
  }));
}

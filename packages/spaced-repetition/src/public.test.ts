import { describe, expect, it } from "bun:test";
import { createSession, DEFAULT_SETTINGS } from "./index";
import type { AnswerCommand, ReviewSnapshot, Session, SessionOptions, SessionView } from "./index";
import { evaluateAnswer, RevisionConflict } from "./server";

const now = new Date("2026-09-10T09:00:00Z");
const word = {
  id: "w1",
  text: "fenêtre",
  gloss: "finestra",
  hint: null,
  image: null,
  kind: "word" as const,
  freqRank: 1,
};
const empty = (): ReviewSnapshot => ({ words: [{ ...word }], cards: [], guesses: [] });
const collect =
  (answers: AnswerCommand[]) =>
  (answer: AnswerCommand): undefined => {
    answers.push(structuredClone(answer));
  };

function firstRecall(acceptAnswer?: SessionOptions["acceptAnswer"]): Session {
  const session = createSession({ snapshot: empty(), clock: () => now, acceptAnswer });
  session.submitGuess("");
  session.exposureDone();
  return session;
}

describe("the public spaced-repetition interface", () => {
  it("rejects asynchronous acceptance before any answer can be submitted", () => {
    let called = false;
    const asyncSink = async () => {
      called = true;
    };
    // @ts-expect-error Durable acceptance cannot be an asynchronous callback.
    const acceptAnswer: SessionOptions["acceptAnswer"] = asyncSink;
    expect(() => createSession({ snapshot: empty(), acceptAnswer })).toThrow(/must be synchronous/);
    expect(called).toBe(false);
  });

  it.each([
    { newPerDay: -1 },
    { newPerDay: 1.5 },
    { newPerDay: 101 },
    { newPerDay: Number.NaN },
    { dayRolloverHour: -1 },
    { dayRolloverHour: 24 },
    { dayRolloverHour: 2.5 },
    { lang: "" },
  ])("rejects invalid session settings %j", (overrides) => {
    expect(() =>
      createSession({ snapshot: empty(), settings: { ...DEFAULT_SETTINGS, ...overrides } }),
    ).toThrow();
  });

  it("does not change state when reading the clock fails", () => {
    let invalid = false;
    const session = createSession({
      snapshot: empty(),
      clock: () => (invalid ? new Date(NaN) : now),
    });
    const before = session.view;
    invalid = true;
    expect(() => session.submitGuess("")).toThrow(/invalid date/);
    expect(session.view).toEqual(before);
    invalid = false;
    session.submitGuess("");
    expect(session.view.phase).toBe("exposure");
  });
  it("emits durable commands and resumes an interrupted introduction without a schedule", () => {
    const answers: AnswerCommand[] = [];
    const session = createSession({
      snapshot: empty(),
      clock: () => now,
      acceptAnswer: collect(answers),
    });
    session.submitGuess("");
    const guess = answers[0]!;
    expect(guess).toMatchObject({ phase: "guess", rating: null, expectedReps: 0 });
    const evaluated = evaluateAnswer(guess, word.text, undefined, now);
    expect(evaluated.correct).toBe(false);
    expect(evaluated.nextSchedule).toBeNull();
    expect(evaluated.revision).toBe(0);
    const resumed = createSession({
      snapshot: { ...empty(), guesses: [{ wordId: word.id, reviewedAt: guess.reviewedAt }] },
      clock: () => now,
    });
    expect(resumed.view.phase).toBe("exposure");
  });

  it("keeps the study-day allowance in the learner's local timezone", () => {
    const localNow = new Date(2026, 8, 10, 5);
    const snapshot = {
      ...empty(),
      guesses: [{ wordId: "already-met", reviewedAt: new Date(2026, 8, 10, 3).toISOString() }],
    };
    const settings = { ...DEFAULT_SETTINGS, newPerDay: 1 };
    expect(createSession({ snapshot, settings, clock: () => localNow }).view.phase).toBe("guess");
    snapshot.guesses[0]!.reviewedAt = new Date(2026, 8, 10, 4).toISOString();
    expect(createSession({ snapshot, settings, clock: () => localNow }).view.phase).toBe("done");
  });

  it.each(["fenêtre", "fenetre", "wrong"])(
    "saves, reloads, and reviews %s through public commands",
    (typed) => {
      const answers: AnswerCommand[] = [];
      const original = firstRecall(collect(answers));
      original.submitRecall(typed, "good");
      const recall = answers[1]!;
      const result = evaluateAnswer(JSON.parse(JSON.stringify(recall)), word.text, undefined, now);
      expect(result.correct).toBe(typed === word.text);
      expect(result.revision).toBe(1);
      const stored = JSON.parse(result.nextSchedule!);
      expect(stored.reps).toBe(1);
      expect(stored.last_review).toBe(now.toISOString());
      const later = new Date(new Date(stored.due).getTime() + 1);
      const resumed = createSession({
        snapshot: JSON.parse(
          JSON.stringify({
            ...empty(),
            cards: [{ wordId: word.id, schedule: result.nextSchedule }],
            guesses: [{ wordId: word.id, reviewedAt: answers[0]!.reviewedAt }],
          }),
        ),
        clock: () => later,
        acceptAnswer: collect(answers),
      });
      expect(resumed.view.phase).toBe("recall");
      resumed.submitRecall(word.text, "easy");
      const next = answers[2]!;
      expect(next.expectedReps).toBe(1);
      expect(new Set(answers.map((a) => a.id)).size).toBe(3);
      const updated = evaluateAnswer(next, word.text, result.nextSchedule!, later);
      expect(updated.correct).toBe(true);
      expect(updated.revision).toBe(2);
      expect(JSON.parse(updated.previousSchedule)).toEqual(stored);
      expect(JSON.parse(updated.nextSchedule!).last_review).toBe(later.toISOString());
      expect(() => evaluateAnswer(next, word.text, updated.nextSchedule!, later)).toThrow(
        RevisionConflict,
      );
    },
  );

  it("rejects oversized recall without advancing state, then accepts a valid retry", () => {
    const answers: AnswerCommand[] = [];
    const session = firstRecall(collect(answers));
    const before = session.view;
    expect(() => session.submitRecall("x".repeat(1001), "good")).toThrow();
    expect(session.view).toEqual(before);
    expect(answers).toHaveLength(1);
    session.submitRecall(word.text, "good");
    expect(answers[1]!.expectedReps).toBe(0);
    expect(evaluateAnswer(answers[1], word.text, undefined, now).revision).toBe(1);
    expect(session.view).toMatchObject({ stats: { recalls: 1, correct: 1, wrong: 0 } });
  });

  it("validates answers even when no persistence sink was supplied", () => {
    const session = firstRecall();
    const before = session.view;
    expect(() => session.submitRecall("x".repeat(1001), "good")).toThrow();
    expect(session.view).toEqual(before);
  });

  it.each(["guess", "recall"] as const)(
    "rolls back rejected %s acceptance and permits retry",
    (phase) => {
      const answers: AnswerCommand[] = [];
      let reject = true;
      const session = createSession({
        snapshot: empty(),
        clock: () => now,
        acceptAnswer: (command) => {
          if (command.phase === phase && reject) throw new Error("local storage full");
          answers.push(command);
        },
      });
      if (phase === "recall") {
        session.submitGuess("");
        session.exposureDone();
      }
      const before = session.view;
      const count = answers.length;
      const submit = () =>
        phase === "guess" ? session.submitGuess("") : session.submitRecall(word.text, "good");
      expect(submit).toThrow("local storage full");
      expect(session.view).toEqual(before);
      expect(answers).toHaveLength(count);
      reject = false;
      submit();
      expect(answers).toHaveLength(count + 1);
      expect(answers.at(-1)!.expectedReps).toBe(0);
      expect(evaluateAnswer(answers.at(-1), word.text, undefined, now).revision).toBe(
        phase === "guess" ? 0 : 1,
      );
    },
  );

  it("rejects reentrant actions while publishing the previous complete view", () => {
    let session: Session;
    session = createSession({
      snapshot: empty(),
      clock: () => now,
      acceptAnswer: () => {
        expect(session.view.phase).toBe("guess");
        expect(() => session.submitGuess("")).toThrow(/already being processed/);
      },
    });
    session.submitGuess("");
    expect(session.view.phase).toBe("exposure");
  });

  it("owns its catalogue and never mutates the caller's snapshot", () => {
    const snapshot = empty();
    const before = structuredClone(snapshot);
    const session = createSession({ snapshot, clock: () => now });
    snapshot.words[0]!.text = "changed externally";
    session.submitGuess("");
    expect(session.view).toMatchObject({ phase: "exposure", answer: word.text });
    session.exposureDone();
    session.submitRecall(word.text, "good");
    expect(snapshot.cards).toEqual(before.cards);
    expect(snapshot.guesses).toEqual(before.guesses);
  });

  it("keeps distinct word IDs when translations are repeated", () => {
    const words = [
      { ...word, gloss: "window", hint: "an opening" },
      { ...word, id: "w2", text: "vitre", gloss: "window", hint: "a pane of glass", freqRank: 2 },
    ];
    const answers: AnswerCommand[] = [];
    const session = createSession({
      snapshot: { words, cards: [], guesses: [] },
      clock: () => now,
      acceptAnswer: collect(answers),
    });
    for (const expected of words) {
      expect(session.view).toMatchObject({
        phase: "guess",
        prompt: { gloss: "window", hint: expected.hint },
      });
      session.submitGuess("");
      expect(session.view).toMatchObject({ phase: "exposure", answer: expected.text });
      session.exposureDone();
    }
    for (const expected of words) {
      expect(session.view).toMatchObject({ phase: "recall", prompt: { hint: expected.hint } });
      session.submitRecall(expected.text, "good");
    }
    expect(answers.map((a) => [a.wordId, a.phase])).toEqual([
      ["w1", "guess"],
      ["w2", "guess"],
      ["w1", "recall"],
      ["w2", "recall"],
    ]);
    for (const answer of answers.filter((a) => a.phase === "recall")) {
      const expected = words.find((w) => w.id === answer.wordId)!;
      expect(evaluateAnswer(answer, expected.text, undefined, now).correct).toBe(true);
    }
  });

  it("grades a real chunk through the same public path as a single word", () => {
    const chunk = {
      ...word,
      kind: "chunk" as const,
      text: "Tu es déjà là ?",
      gloss: "Sei già qui?",
      hint: "a question",
      image: "👋",
    };
    const answers: AnswerCommand[] = [];
    const session = createSession({
      snapshot: { words: [chunk], cards: [], guesses: [] },
      clock: () => now,
      acceptAnswer: collect(answers),
    });
    expect(session.view).toMatchObject({
      prompt: { kind: "chunk", hint: chunk.hint, image: chunk.image },
    });
    session.submitGuess("");
    session.exposureDone();
    session.submitRecall("  tu es  déjà là ! ?  ", "good");
    expect(evaluateAnswer(answers[1], chunk.text, undefined, now).correct).toBe(true);
  });

  it("rejects a local clock before the saved review, then accepts after correction", () => {
    const initial: AnswerCommand[] = [];
    firstRecall(collect(initial)).submitRecall(word.text, "good");
    const first = evaluateAnswer(initial[1], word.text, undefined, now);
    let current = now.getTime() - 1;
    const answers: AnswerCommand[] = [];
    const session = createSession({
      snapshot: {
        ...empty(),
        cards: [{ wordId: word.id, schedule: first.nextSchedule! }],
        guesses: [{ wordId: word.id, reviewedAt: initial[0]!.reviewedAt }],
      },
      clock: () => new Date(current),
      acceptAnswer: collect(answers),
    });
    const before = session.view;
    expect(before.phase).toBe("recall");
    expect(() => session.submitRecall(word.text, "good")).toThrow(RevisionConflict);
    expect(session.view).toEqual(before);
    expect(answers).toHaveLength(0);
    current = now.getTime();
    session.submitRecall(word.text, "good");
    expect(answers[0]!.expectedReps).toBe(1);
    expect(evaluateAnswer(answers[0], word.text, first.nextSchedule!, now).revision).toBe(2);
  });

  it("does not expose mutable internal waiting dates or statistics", () => {
    const session = firstRecall();
    session.submitRecall(word.text, "good");
    const before = structuredClone(session.view);
    const view = session.view;
    expect(view.phase).toBe("caughtUp");
    if (view.phase !== "caughtUp") throw new Error("Expected a waiting session");
    view.nextDueAt.setTime(0);
    view.stats.recalls = 999;
    expect(session.view).toEqual(before);
  });

  it.each([
    [-1000, 0],
    [1234, 1234],
    [172_800_000, 86_400_000],
  ])("clamps elapsed %i to latency %i", (elapsed, expected) => {
    let current = now.getTime();
    const commands: AnswerCommand[] = [];
    const session = createSession({
      snapshot: empty(),
      clock: () => new Date(current),
      acceptAnswer: collect(commands),
    });
    current += elapsed;
    session.submitGuess("");
    expect(commands[0]!.latencyMs).toBe(expected);
  });
});

const actions = {
  guess: (s: Session) => s.submitGuess(""),
  exposure: (s: Session) => s.exposureDone(),
  recall: (s: Session) => s.submitRecall("wrong", "good"),
  feedback: (s: Session) => s.dismissFeedback(),
};
const phases: SessionView["phase"][] = [
  "guess",
  "exposure",
  "recall",
  "feedback",
  "caughtUp",
  "done",
];
const invalidPairs = phases.flatMap((phase) =>
  (Object.keys(actions) as (keyof typeof actions)[])
    .filter((action) => action !== phase)
    .map((action) => [phase, action] as const),
);

describe("phase-safe actions", () => {
  it.each(invalidPairs)(
    "rejects %s/%s without changing state or publishing answers",
    (phase, action) => {
      const commands: AnswerCommand[] = [];
      const session = createSession({
        snapshot: phase === "done" ? { words: [], cards: [], guesses: [] } : empty(),
        clock: () => now,
        acceptAnswer: collect(commands),
      });
      if (phase !== "done" && phase !== "guess") session.submitGuess("");
      if (["recall", "feedback", "caughtUp"].includes(phase)) session.exposureDone();
      if (phase === "feedback") session.submitRecall("wrong", "good");
      if (phase === "caughtUp") session.submitRecall(word.text, "good");
      expect(session.view.phase).toBe(phase);
      const before = structuredClone(session.view);
      const saved = structuredClone(commands);
      expect(() => actions[action](session)).toThrow(/expected phase/);
      expect(session.view).toEqual(before);
      expect(commands).toEqual(saved);
    },
  );
});

import { describe, expect, it } from "vitest";
import { createSession, DEFAULT_SETTINGS } from "./index";
import type { AnswerCommand, ReviewSnapshot } from "./index";
import { evaluateAnswer, RevisionConflict } from "./server";
import { createSession as internalSession } from "./session";
import { commandFor } from "./lib/commands";

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
const empty = (): ReviewSnapshot => ({ words: [word], cards: [], guesses: [] });

describe("the public spaced-repetition interface", () => {
  it("emits durable commands and resumes an interrupted introduction without a schedule", () => {
    const answers: AnswerCommand[] = [];
    const session = createSession({
      snapshot: empty(),
      clock: () => now,
      onAnswer: (answer) => answers.push(answer),
    });
    expect(session.view.phase).toBe("guess");
    session.submitGuess("");
    const guess = answers[0]!;
    expect(guess).toMatchObject({ phase: "guess", rating: null, expectedReps: 0 });
    expect(evaluateAnswer(guess, word.text, undefined, now).nextSchedule).toBeNull();
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
    "derives exactly the same schedule in session and server for %s",
    (typed) => {
      let schedule: string | undefined;
      const answers: AnswerCommand[] = [];
      const session = internalSession({
        words: [word],
        cards: [],
        newPerDay: 1,
        clock: () => now,
        onAttempt: (attempt) => answers.push(commandFor(attempt)),
        onCardChange: (card) => {
          schedule = JSON.stringify(card.fsrs);
        },
      });
      session.submitGuess("");
      session.exposureDone();
      session.submitRecall(typed, "good");
      const result = evaluateAnswer(answers[1]!, word.text, undefined, now);
      expect(result.nextSchedule).toBe(schedule);
      expect(result.revision).toBe(1);
    },
  );

  it("rejects first-recall Easy, mismatched ratings, stale revisions, and future timestamps", () => {
    const recall: AnswerCommand = {
      id: crypto.randomUUID(),
      wordId: word.id,
      phase: "recall",
      typed: word.text,
      rating: 3,
      latencyMs: 1,
      reviewedAt: now.toISOString(),
      expectedReps: 0,
    };
    expect(() => evaluateAnswer({ ...recall, rating: 4 }, word.text, undefined, now)).toThrow(
      /Easy/,
    );
    expect(() => evaluateAnswer({ ...recall, typed: "wrong" }, word.text, undefined, now)).toThrow(
      /Rating/,
    );
    const first = evaluateAnswer(recall, word.text, undefined, now);
    expect(() => evaluateAnswer(recall, word.text, first.nextSchedule!, now)).toThrow(
      RevisionConflict,
    );
    expect(() =>
      evaluateAnswer(
        { ...recall, reviewedAt: new Date(now.getTime() + 300_001).toISOString() },
        word.text,
        undefined,
        now,
      ),
    ).toThrow(/future/);
  });
});

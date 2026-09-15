import fc from "fast-check";
import { describe, expect, it } from "bun:test";
import { catalogue, createLearner } from "./harness";
import type { Behaviour, Learner, Step } from "./harness";
import { attemptMismatches, closureContradictions, violations } from "./invariants";
import type { Effort } from "./types";

/**
 * The session's promises, checked against sequences nobody wrote down.
 *
 * The example tests next door cover the cases we thought of. Every bug this
 * module has shipped was a case we did not: a card written but never rated, a
 * word guessed but never recalled, an exposure the rule could not see. Those are
 * reachable states rather than wrong arithmetic, and the way to find a reachable
 * state you have not imagined is to generate the ways of reaching it.
 *
 * So each run here is a whole history — open the app, answer some prompts, close
 * it mid-flow, come back minutes or days later — rebuilt each time from what the
 * previous sitting actually wrote.
 */

const NINE_AM = new Date("2026-08-10T09:00:00");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Local wall-clock dates cover leap days, year ends, DST seasons and rollovers.
const startDates = fc.constantFrom(
  "2024-02-28T23:59:30",
  "2024-02-29T03:59:30",
  "2026-12-31T23:59:30",
  "2026-03-08T01:59:30",
  "2026-03-29T01:59:30",
  "2026-10-25T02:30:00",
  "2026-11-01T01:30:00",
  "2026-08-10T09:00:00",
  "2026-08-10T03:59:30",
);

type Scenario = {
  start: string;
  rollover: number;
  variedCatalogue: boolean;
  words: number;
  newPerDay: number;
  /** One entry per sitting: how many prompts before the app is closed. */
  cuts: number[];
  /** How long the learner stays away between sittings. */
  gaps: number[];
  answers: boolean[];
  efforts: Effort[];
  /**
   * How long each prompt takes, cycled. Up to five minutes, because a learner
   * who lingers on one screen lets cards come due mid-sitting — the shape that
   * made a failed card come straight back through its own feedback, which a
   * fixed 18s pace could never produce.
   */
  thinks: number[];
};

function scenario(options: { maxGap: number }) {
  return fc.record({
    start: startDates,
    rollover: fc.integer({ min: 0, max: 23 }),
    variedCatalogue: fc.boolean(),
    words: fc.integer({ min: 1, max: 25 }),
    newPerDay: fc.integer({ min: 0, max: 12 }),
    cuts: fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 8 }),
    gaps: fc.array(fc.integer({ min: 0, max: options.maxGap }), { minLength: 1, maxLength: 8 }),
    answers: fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
    efforts: fc.array(fc.constantFrom<Effort>("hard", "good", "easy"), {
      minLength: 1,
      maxLength: 8,
    }),
    thinks: fc.array(fc.integer({ min: 1000, max: 5 * MINUTE }), { minLength: 1, maxLength: 10 }),
  });
}

function behaviourFor(s: Scenario): Behaviour {
  let guessed = 0;
  let answered = 0;
  let graded = 0;
  let thought = 0;
  return {
    guessCorrect: () => s.answers[guessed++ % s.answers.length]!,
    correct: () => s.answers[answered++ % s.answers.length]!,
    effort: () => s.efforts[graded++ % s.efforts.length]!,
    msPerPrompt: () => s.thinks[thought++ % s.thinks.length]!,
  };
}

/**
 * Play a whole history out.
 *
 * The final sitting is capped rather than run to exhaustion, because a learner
 * who is wrong every single time genuinely never finishes: each wrong answer is
 * rated Again and comes back due in a minute, which is correct — a card you keep
 * failing keeps coming back, exactly as it should. Termination is asserted
 * separately, against a learner who sometimes gets one right.
 */
function wordsFor(s: Scenario) {
  return catalogue(s.words).map((word, i) =>
    s.variedCatalogue
      ? {
          ...word,
          text: i % 2 ? `l'été ${i}` : `être${i}`,
          freqRank: i % 3 === 0 ? null : Math.floor((s.words - i) / 2),
        }
      : word,
  );
}

function live(s: Scenario): Learner {
  const learner = createLearner({
    words: wordsFor(s),
    newPerDay: s.newPerDay,
    start: new Date(s.start),
    behaviour: behaviourFor(s),
    dayRolloverHour: s.rollover,
  });

  s.cuts.forEach((cut, i) => {
    learner.sit(cut);
    learner.wait(s.gaps[i % s.gaps.length]!);
  });
  learner.sit(200);
  return learner;
}

describe("however the history goes", () => {
  it("holds every invariant", () => {
    // The rollover hour is generated too: what "today" means shifts with it,
    // and the invariants must agree with the queue about the boundary at any
    // setting, not just midnight.
    fc.assert(
      fc.property(scenario({ maxGap: 3 * DAY }), fc.integer({ min: 0, max: 23 }), (s, rollover) => {
        const learner = createLearner({
          words: wordsFor(s),
          newPerDay: s.newPerDay,
          start: new Date(s.start),
          behaviour: behaviourFor(s),
          dayRolloverHour: rollover,
        });
        s.cuts.forEach((cut, i) => {
          learner.sit(cut);
          learner.wait(s.gaps[i % s.gaps.length]!);
        });
        learner.sit(200);
        expect(violations(learner.trace, learner.attempts, rollover)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("ends for any learner who eventually gets each word right", () => {
    // A learner who keeps failing a word forever genuinely never finishes: the
    // card is rated Again and comes back due in a minute, which is the
    // scheduler working — that is the leech gap in the README, and a decision
    // rather than a bug. The promise this pins is the complement: stumble on
    // each word a bounded number of times and the session always ends. The
    // earlier form of this property ("one wrong answer in every N") was
    // quietly weaker — cycled across enough slow-paced cards it can pin every
    // wrong answer onto the same word, which is the forever-failing learner
    // again. `sit()` throws rather than hangs if the end never comes, so
    // reaching the assertion at all is most of the property.
    fc.assert(
      fc.property(
        fc.record({
          start: startDates,
          rollover: fc.integer({ min: 0, max: 23 }),
          words: fc.integer({ min: 1, max: 25 }),
          newPerDay: fc.integer({ min: 0, max: 12 }),
          cuts: fc.array(fc.integer({ min: 1, max: 15 }), { minLength: 1, maxLength: 8 }),
          gaps: fc.array(fc.integer({ min: 0, max: 7 * DAY }), { minLength: 1, maxLength: 8 }),
          stumbles: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 25 }),
          thinks: fc.array(fc.integer({ min: 1000, max: 5 * MINUTE }), {
            minLength: 1,
            maxLength: 10,
          }),
        }),
        (s) => {
          let thought = 0;
          const stumblesFor = (id: string) => s.stumbles[Number(id.slice(1)) % s.stumbles.length]!;
          const learner = createLearner({
            words: catalogue(s.words),
            newPerDay: s.newPerDay,
            start: new Date(s.start),
            dayRolloverHour: s.rollover,
            behaviour: {
              correct: (word, n) => n > stumblesFor(word.id),
              msPerPrompt: () => s.thinks[thought++ % s.thinks.length]!,
            },
          });

          s.cuts.forEach((cut, i) => {
            learner.sit(cut);
            learner.wait(s.gaps[i % s.gaps.length]!);
          });
          learner.sit();

          const end = learner.trace.at(-1)!;
          expect(end.at).toBe("closed");
          if (end.at !== "closed") throw new Error("missing closed marker");
          expect(end.reason).not.toBe("cut");
          expect(closureContradictions(learner.trace)).toEqual([]);
          expect(violations(learner.trace, learner.attempts, s.rollover)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("reopens caught-up histories at the earliest remaining learning due", () => {
    fc.assert(
      fc.property(scenario({ maxGap: 3 * DAY }), (s) => {
        const learner = live(s);
        const end = learner.trace.at(-1)!;
        if (end.at !== "closed" || end.reason !== "caughtUp") return;
        expect(closureContradictions(learner.trace)).toEqual([]);
        const due = end.nextDueAt!;
        learner.wait(due - learner.now.getTime());
        const reopened = learner.sit(1)[0]!;
        expect(reopened.at).toBe("recall");
        if (reopened.at !== "recall") throw new Error("reopen did not serve due learning");
        expect(reopened.shownAt).toBe(due);
        expect(
          end.remainingLearning.some((c) => c.wordId === reopened.wordId && c.due === due),
        ).toBe(true);
        expect(violations(learner.trace, learner.attempts, s.rollover)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it("never exceeds the day's new-word allowance", () => {
    // Gaps stay inside the day: the allowance is read once when the app opens,
    // so a sitting that runs past midnight is the UI's problem to solve by
    // reloading, not something the rule can see.
    fc.assert(
      fc.property(scenario({ maxGap: HOUR }), (s) => {
        const learner = createLearner({
          words: catalogue(s.words),
          newPerDay: s.newPerDay,
          start: NINE_AM,
          behaviour: behaviourFor(s),
        });

        for (const [i, cut] of s.cuts.entries()) {
          learner.sit(cut);
          expect(learner.introducedToday).toBeLessThanOrEqual(s.newPerDay);
          learner.wait(s.gaps[i % s.gaps.length]!);
        }
        learner.sit(200);
        expect(learner.introducedToday).toBeLessThanOrEqual(s.newPerDay);
      }),
      { numRuns: 300 },
    );
  });

  it("never shows a word it has not introduced", () => {
    // Restated from the trace rather than the attempts: every card that appears
    // on screen at all must have been guessed first, in some sitting.
    fc.assert(
      fc.property(scenario({ maxGap: 2 * DAY }), (s) => {
        const learner = live(s);
        const introduced = new Set<string>();

        for (const step of learner.trace as Step[]) {
          if (step.at === "closed") continue;
          if (step.at === "guess") introduced.add(step.word);
          else expect(introduced.has(step.word), `${step.at} of an unintroduced word`).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("logs one attempt per prompt that takes an answer", () => {
    // Guesses and recalls are answered; exposures and feedback are read. The
    // attempts table is the source of truth for FSRS retraining, so a prompt
    // that vanishes from it is history that cannot be rebuilt.
    fc.assert(
      fc.property(scenario({ maxGap: DAY }), (s) => {
        const learner = live(s);
        const answered = learner.trace.filter(
          (step) => step.at === "guess" || step.at === "recall",
        );
        expect(learner.attempts).toHaveLength(answered.length);
        expect(attemptMismatches(learner.trace, learner.attempts)).toEqual([]);
        expect(learner.commands.map((c) => c.id).length).toBe(
          new Set(learner.commands.map((c) => c.id)).size,
        );
      }),
      { numRuns: 200 },
    );
  });
});

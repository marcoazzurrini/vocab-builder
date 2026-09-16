import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { createSession, DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import type { AnswerCommand } from "@vocab/spaced-repetition";
import { evaluateAnswer } from "@vocab/spaced-repetition/server";
import { and, eq } from "drizzle-orm";

import { parseCatalogue } from "../scripts/import-catalogue";
import { createDatabase, SaveConflict } from "./index";
import { attempts, cards, settings, user, words } from "./schema";
import { testDatabase } from "./testing";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let store: ReturnType<typeof createDatabase>;
let serial = 0;
const now = new Date("2026-09-10T09:00:00.000Z");

beforeEach(async () => {
  fixture = await testDatabase();
  store = createDatabase(fixture.binding);
});
afterEach(async () => {
  await fixture?.close();
});

const learner = async () => {
  serial += 1;
  const id = `user-${serial}`;
  await fixture.db.insert(user).values({
    createdAt: now,
    email: `${id}@example.com`,
    id,
    name: "Learner",
    updatedAt: now,
  });
  const wordId = `word-${serial}`;
  await fixture.db
    .insert(words)
    .values({ gloss: `cane-${serial}`, id: wordId, lang: "fr", text: "chien" });
  const guess: AnswerCommand = {
    expectedReps: 0,
    id: crypto.randomUUID(),
    latencyMs: 1000,
    phase: "guess",
    rating: null,
    reviewedAt: now.toISOString(),
    typed: "",
    wordId,
  };
  const recall: AnswerCommand = {
    ...guess,
    id: crypto.randomUUID(),
    phase: "recall",
    rating: 3,
    reviewedAt: new Date(now.getTime() + 60_000).toISOString(),
    typed: "chien",
  };
  return { guess, id, recall, wordId };
};

const history = (userId: string) =>
  fixture.db
    .select()
    .from(attempts)
    .where(eq(attempts.user_id, userId))
    .orderBy(attempts.id);
const schedule = (userId: string) =>
  fixture.db
    .select()
    .from(cards)
    .where(eq(cards.user_id, userId))
    .orderBy(cards.word_id);

const savedProgress = async (userId: string) => ({
  attempts: await history(userId),
  cards: await schedule(userId),
});

/** Pause immediately before a real D1 batch, after repository reads and evaluation. */
const coordinateBatches = (beforeBatch: () => Promise<void>) =>
  createDatabase({
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await beforeBatch();
      return fixture.binding.batch<T>(statements);
    },
    dump: () => fixture.binding.dump(),
    exec: (query) => fixture.binding.exec(query),
    prepare: (query) => fixture.binding.prepare(query),
    withSession: (bookmark) => fixture.binding.withSession(bookmark),
  });

const twoWriters = () => {
  const gate = Promise.withResolvers<null>();
  let arrivals = 0;
  const timer = setTimeout(
    () => gate.reject(new Error("Both writers must reach the batch barrier.")),
    5000
  );
  return {
    get arrivals() {
      return arrivals;
    },
    arrive: async () => {
      arrivals += 1;
      if (arrivals === 2) {
        clearTimeout(timer);
        gate.resolve(null);
      }
      await gate.promise;
    },
    close: () => clearTimeout(timer),
  };
};

/** Test persistence against the domain evaluator, without reimplementing FSRS. */
const expectSavedAnswer = async (
  userId: string,
  command: AnswerCommand,
  previousSchedule?: string,
  spelling = "chien"
) => {
  const evaluated = evaluateAnswer(
    command,
    spelling,
    previousSchedule,
    new Date(command.reviewedAt)
  );
  const savedHistory = await history(userId);
  const row = savedHistory.find((entry) => entry.id === command.id);
  expect(row).toEqual({
    card_type: "production",
    correct: evaluated.correct,
    id: command.id,
    latency_ms: command.latencyMs,
    phase: command.phase,
    rating: command.rating,
    rep_number: evaluated.revision,
    request: expect.any(String),
    reviewed_at: new Date(command.reviewedAt).toISOString(),
    state_before: JSON.parse(evaluated.previousSchedule),
    typed: command.typed,
    user_id: userId,
    word_id: command.wordId,
  });
  if (!row) {
    throw new Error("Expected the saved answer.");
  }
  expect(JSON.parse(row.request)).toEqual(command);
  const allCards = await schedule(userId);
  const savedCards = allCards.filter((card) => card.word_id === command.wordId);
  expect(savedCards).toEqual(
    evaluated.nextSchedule === null
      ? []
      : [
          {
            card_type: "production",
            fsrs_state: JSON.parse(evaluated.nextSchedule),
            revision: evaluated.revision,
            user_id: userId,
            word_id: command.wordId,
          },
        ]
  );
  return evaluated.nextSchedule;
};

describe("repository isolation and failure contracts", () => {
  it("defaults UI language to automatic and isolates saved preferences by account", async () => {
    const a = await learner();
    const b = await learner();
    expect(await store.forUser(a.id).uiLocale()).toBeNull();
    await store.forUser(a.id).setUiLocale("it");
    expect(await store.forUser(a.id).uiLocale()).toBe("it");
    expect(await store.forUser(b.id).uiLocale()).toBeNull();
    await store.forUser(a.id).setUiLocale("en");
    expect(await store.forUser(a.id).uiLocale()).toBe("en");
    await store.forUser(a.id).setUiLocale(null);
    expect(await store.forUser(a.id).uiLocale()).toBeNull();
  });

  it("changes UI language without changing learning settings or progress", async () => {
    const a = await learner();
    await fixture.db.insert(settings).values({
      day_rollover_hour: 7,
      lang: "fr",
      new_per_day: 5,
      user_id: a.id,
    });
    await store.forUser(a.id).recordAnswer(a.guess);
    const progress = await savedProgress(a.id);
    await store.forUser(a.id).setUiLocale("en");
    expect(await store.forUser(a.id).settings()).toEqual({
      dayRolloverHour: 7,
      lang: "fr",
      newPerDay: 5,
    });
    expect(await savedProgress(a.id)).toEqual(progress);
  });

  it("rejects unsupported UI languages through the database constraint", async () => {
    const a = await learner();
    await store.forUser(a.id).setUiLocale("it");
    await expect(
      fixture.binding
        .prepare("UPDATE settings SET ui_locale = ? WHERE user_id = ?")
        .bind("fr", a.id)
        .run()
    ).rejects.toThrow("CHECK constraint failed");
    expect(await store.forUser(a.id).uiLocale()).toBe("it");
  });

  it("returns independent defaults and never persists mutations to returned settings", async () => {
    const a = await learner();
    const b = await learner();
    const defaults = { dayRolloverHour: 4, lang: "fr", newPerDay: 15 };
    const originalDefaults = { ...DEFAULT_SETTINGS };
    try {
      const first = await store.forUser(a.id).settings();
      expect(first).toEqual(defaults);
      first.newPerDay = 99;
      first.lang = "es";
      first.dayRolloverHour = 0;
      expect(await store.forUser(a.id).settings()).toEqual(defaults);
      expect(await store.forUser(b.id).settings()).toEqual(defaults);
      expect(DEFAULT_SETTINGS).toEqual(defaults);
      await fixture.db.insert(settings).values({
        day_rollover_hour: 7,
        lang: "es",
        new_per_day: 5,
        user_id: a.id,
      });
      const saved = await store.forUser(a.id).settings();
      saved.newPerDay = 88;
      expect(await store.forUser(a.id).settings()).toEqual({
        dayRolloverHour: 7,
        lang: "es",
        newPerDay: 5,
      });
      expect(await store.forUser(b.id).settings()).toEqual(defaults);
    } finally {
      // A regression must fail this test without poisoning later tests in the process.
      Object.assign(DEFAULT_SETTINGS, originalDefaults);
    }
  });

  it.each(["", " ", "\t\n"])("rejects an empty owner %j", (owner) => {
    expect(() => store.forUser(owner)).toThrow("A user ID is required.");
  });

  it("keeps two users' progress independent when they study the same word", async () => {
    const a = await learner();
    const b = await learner();
    const aRepo = store.forUser(a.id);
    const bRepo = store.forUser(b.id);
    await aRepo.recordAnswer(a.guess);
    await aRepo.recordAnswer(a.recall);
    const aBefore = await savedProgress(a.id);
    const bGuess = { ...b.guess, wordId: a.wordId };
    const bRecall: AnswerCommand = {
      ...b.recall,
      rating: 1,
      typed: "wrong",
      wordId: a.wordId,
    };
    await bRepo.recordAnswer(bGuess);
    await bRepo.recordAnswer(bRecall);
    await expectSavedAnswer(b.id, bRecall);
    expect(await savedProgress(a.id)).toEqual(aBefore);
    const bBefore = await savedProgress(b.id);
    const next: AnswerCommand = {
      ...a.recall,
      expectedReps: 1,
      id: crypto.randomUUID(),
      rating: 4,
      reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
    };
    await aRepo.recordAnswer(next);
    expect(await savedProgress(b.id)).toEqual(bBefore);
    const aCards = await schedule(a.id);
    const bCards = await schedule(b.id);
    const aSnapshot = await aRepo.snapshot("fr");
    const bSnapshot = await bRepo.snapshot("fr");
    expect(aCards[0]?.revision).toBe(2);
    expect(bCards[0]?.revision).toBe(1);
    expect(aSnapshot.cards[0]?.wordId).toBe(a.wordId);
    expect(bSnapshot.cards[0]?.wordId).toBe(a.wordId);
  });

  it.each([0, 86_400_000])(
    "persists the accepted latency boundary %i",
    async (latencyMs) => {
      const l = await learner();
      const command = { ...l.guess, latencyMs };
      await store.forUser(l.id).recordAnswer(command);
      await expectSavedAnswer(l.id, command);
    }
  );

  it("persists wrong and subsequent correct recalls with complete audit and scheduling fields", async () => {
    const l = await learner();
    const repo = store.forUser(l.id);
    await repo.recordAnswer(l.guess);
    const wrong: AnswerCommand = {
      ...l.recall,
      latencyMs: 4321,
      rating: 1,
      reviewedAt: "2026-09-10T11:01:00.000+02:00",
      typed: "chién",
    };
    await repo.recordAnswer(wrong);
    const previous = await expectSavedAnswer(l.id, wrong);
    if (previous === null) {
      throw new Error("Expected a recall schedule.");
    }
    const next: AnswerCommand = {
      ...l.recall,
      expectedReps: 1,
      id: crypto.randomUUID(),
      latencyMs: 789,
      rating: 2,
      reviewedAt: new Date(now.getTime() + 180_000).toISOString(),
    };
    await repo.recordAnswer(next);
    await expectSavedAnswer(l.id, next, previous);
    expect(await history(l.id)).toHaveLength(3);
  });

  it("rolls back an attempted update without changing the existing card or history", async () => {
    const l = await learner();
    const repo = store.forUser(l.id);
    await repo.recordAnswer(l.guess);
    await repo.recordAnswer(l.recall);
    const before = await savedProgress(l.id);
    await fixture.binding
      .prepare(
        "CREATE TRIGGER reject_card_update BEFORE UPDATE ON cards BEGIN SELECT RAISE(ABORT, 'injected_update_failure'); END;"
      )
      .run();
    const next: AnswerCommand = {
      ...l.recall,
      expectedReps: 1,
      id: crypto.randomUUID(),
      reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
    };
    try {
      await expect(repo.recordAnswer(next)).rejects.toThrow(
        "injected_update_failure"
      );
      expect(await savedProgress(l.id)).toEqual(before);
    } finally {
      await fixture.binding.prepare("DROP TRIGGER reject_card_update").run();
    }
    await repo.recordAnswer(next);
    expect(await history(l.id)).toHaveLength(3);
    const savedCards = await schedule(l.id);
    expect(savedCards[0]?.revision).toBe(2);
  });

  it("rejects a delayed new answer based on an old revision without changing progress", async () => {
    const l = await learner();
    const repo = store.forUser(l.id);
    await repo.recordAnswer(l.guess);
    await repo.recordAnswer(l.recall);
    const before = await savedProgress(l.id);
    await expect(
      repo.recordAnswer({ ...l.recall, id: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(SaveConflict);
    await expect(
      repo.recordAnswer({
        ...l.recall,
        expectedReps: 1,
        id: crypto.randomUUID(),
        reviewedAt: l.guess.reviewedAt,
      })
    ).rejects.toBeInstanceOf(SaveConflict);
    expect(await savedProgress(l.id)).toEqual(before);
  });

  it("rejects changed IDs and payloads without modifying either user's progress", async () => {
    const a = await learner();
    const b = await learner();
    await store.forUser(a.id).recordAnswer(a.guess);
    const before = await savedProgress(a.id);
    await expect(
      store.forUser(b.id).recordAnswer(a.guess)
    ).rejects.toBeInstanceOf(SaveConflict);
    await expect(
      store.forUser(a.id).recordAnswer({ ...a.guess, id: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(SaveConflict);
    for (const change of [
      { typed: "different" },
      { latencyMs: 99 },
      { wordId: b.wordId },
      { reviewedAt: new Date(now.getTime() + 1000).toISOString() },
    ]) {
      // Independent payload variations must all reject a reused idempotency key.
      // eslint-disable-next-line no-await-in-loop
      await expect(
        store.forUser(a.id).recordAnswer({ ...a.guess, ...change })
      ).rejects.toThrow(
        "An answer ID cannot be reused for a different answer."
      );
    }
    expect(await savedProgress(a.id)).toEqual(before);
    expect(await savedProgress(b.id)).toEqual({ attempts: [], cards: [] });
  });

  it("returns ordered, fully mapped words and an empty snapshot for an unknown language", async () => {
    const l = await learner();
    const entries = [
      { freq_rank: 2, gloss: "bee", id: "tie-b", lang: "it", text: "b" },
      { freq_rank: null, gloss: "zed", id: "unranked", lang: "it", text: "z" },
      { freq_rank: 2, gloss: "aye", id: "tie-a", lang: "it", text: "a" },
      {
        freq_rank: 1,
        gloss: "hello",
        hint: "greeting",
        id: "first",
        image: "image.png",
        kind: "chunk" as const,
        lang: "it",
        text: "ciao",
      },
    ];
    await fixture.db.insert(words).values(entries);
    const snapshot = await store.forUser(l.id).snapshot("it");
    expect(snapshot).toEqual({
      cards: [],
      guesses: [],
      words: [entries[3], entries[2], entries[0], entries[1]].map((entry) => {
        if (!entry) {
          throw new Error("Expected catalogue fixture.");
        }
        return {
          freqRank: entry.freq_rank,
          gloss: entry.gloss,
          hint: entry.hint ?? null,
          id: entry.id,
          image: entry.image ?? null,
          kind: entry.kind ?? "word",
          text: entry.text,
        };
      }),
    });
    expect(await store.forUser(l.id).snapshot("missing-language")).toEqual({
      cards: [],
      guesses: [],
      words: [],
    });
  });

  it.each(["{}", "null"])(
    "rejects an unreadable saved schedule %s without writing",
    async (corrupted) => {
      const l = await learner();
      const repo = store.forUser(l.id);
      await repo.recordAnswer(l.guess);
      await repo.recordAnswer(l.recall);
      await fixture.binding
        .prepare("UPDATE cards SET fsrs_state = ? WHERE user_id = ?")
        .bind(corrupted, l.id)
        .run();
      const before = await savedProgress(l.id);
      await expect(
        repo.recordAnswer({
          ...l.recall,
          expectedReps: 1,
          id: crypto.randomUUID(),
        })
      ).rejects.toThrow("Unreadable scheduling state");
      expect(await savedProgress(l.id)).toEqual(before);
    }
  );

  it("rejects mismatched stored revision and schedule without appending history", async () => {
    const l = await learner();
    const repo = store.forUser(l.id);
    await repo.recordAnswer(l.guess);
    await repo.recordAnswer(l.recall);
    await fixture.db
      .update(cards)
      .set({ revision: 9 })
      .where(eq(cards.user_id, l.id));
    const before = await savedProgress(l.id);
    await expect(
      repo.recordAnswer({
        ...l.recall,
        expectedReps: 1,
        id: crypto.randomUUID(),
        reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
      })
    ).rejects.toBeInstanceOf(SaveConflict);
    expect(await savedProgress(l.id)).toEqual(before);
  });

  it.each(["not json", "{}"])(
    "rejects a malformed saved command %s without writing",
    async (request) => {
      const l = await learner();
      await fixture.db.insert(attempts).values({
        card_type: "production",
        correct: false,
        id: l.guess.id,
        latency_ms: 1000,
        phase: "guess",
        rating: null,
        rep_number: 0,
        request,
        reviewed_at: l.guess.reviewedAt,
        state_before: { reps: 0 },
        typed: "",
        user_id: l.id,
        word_id: l.wordId,
      });
      const before = await savedProgress(l.id);
      await expect(store.forUser(l.id).recordAnswer(l.guess)).rejects.toThrow();
      expect(await savedProgress(l.id)).toEqual(before);
    }
  );
});

describe("D1 persistence", () => {
  it("preserves the public SaveConflict error contract", () => {
    const error = new SaveConflict();
    expect(error).toBeInstanceOf(Error);
    expect(error.constructor.name).toBe("SaveConflict");
    expect(error.name).toBe("Error");
    expect(String(error)).toBe(
      "Error: Progress changed on another device. Reload before answering again."
    );
    expect(JSON.stringify(error)).toBe("{}");
  });

  it("restores awaiting guesses and atomically saves a first recall", async () => {
    const l = await learner();
    await store.forUser(l.id).recordAnswer(l.guess);
    await expectSavedAnswer(l.id, l.guess);
    const rows = await store.forUser(l.id).snapshot("fr");
    const session = createSession({ clock: () => now, snapshot: rows });
    expect(session.view.phase).toBe("exposure");
    await store.forUser(l.id).recordAnswer(l.recall);
    expect(await history(l.id)).toHaveLength(2);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(1);
    expect(card?.fsrs_state).toEqual(expect.objectContaining({ reps: 1 }));
    await expectSavedAnswer(l.id, l.recall);
  });

  it("rolls back the attempt when the second statement fails", async () => {
    const l = await learner();
    await store.forUser(l.id).recordAnswer(l.guess);
    await fixture.binding
      .prepare(
        `CREATE TRIGGER reject_card BEFORE INSERT ON cards WHEN NEW.user_id = '${l.id}' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`
      )
      .run();
    const before = await savedProgress(l.id);
    try {
      await expect(store.forUser(l.id).recordAnswer(l.recall)).rejects.toThrow(
        "injected_failure"
      );
      expect(await savedProgress(l.id)).toEqual(before);
    } finally {
      await fixture.binding.prepare("DROP TRIGGER reject_card").run();
    }
  });

  it("makes retries idempotent, even after later recalls", async () => {
    const l = await learner();
    await store.forUser(l.id).recordAnswer(l.guess);
    await store.forUser(l.id).recordAnswer(l.guess);
    await store.forUser(l.id).recordAnswer(l.recall);
    const second = {
      ...l.recall,
      expectedReps: 1,
      id: crypto.randomUUID(),
      reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
    };
    await store.forUser(l.id).recordAnswer(second);
    const beforeReplay = await savedProgress(l.id);
    await store.forUser(l.id).recordAnswer(l.recall);
    expect(await savedProgress(l.id)).toEqual(beforeReplay);
    expect(await history(l.id)).toHaveLength(3);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(2);
  });

  it("accepts racing retries of the same answer without duplicating history", async () => {
    const l = await learner();
    await store.forUser(l.id).recordAnswer(l.guess);
    const barrier = twoWriters();
    const writer = coordinateBatches(barrier.arrive).forUser(l.id);
    try {
      const results = await Promise.allSettled([
        writer.recordAnswer(l.recall),
        writer.recordAnswer(l.recall),
      ]);
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(barrier.arrivals).toBe(2);
    } finally {
      barrier.close();
    }
    await expectSavedAnswer(l.id, l.recall);
    expect(await history(l.id)).toHaveLength(2);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(1);
  });

  it("accepts historical command property order without replaying progress", async () => {
    const l = await learner();
    const request = JSON.stringify(l.guess, [
      "id",
      "wordId",
      "phase",
      "typed",
      "rating",
      "latencyMs",
      "reviewedAt",
      "expectedReps",
    ]);
    expect(request).not.toBe(JSON.stringify(l.guess));
    // Insert the historical bytes directly because attempt history is append-only.
    await fixture.db.insert(attempts).values({
      card_type: "production",
      correct: false,
      id: l.guess.id,
      latency_ms: l.guess.latencyMs,
      phase: l.guess.phase,
      rating: l.guess.rating,
      rep_number: 0,
      request,
      reviewed_at: l.guess.reviewedAt,
      state_before: { reps: 0 },
      typed: l.guess.typed,
      user_id: l.id,
      word_id: l.wordId,
    });
    await store.forUser(l.id).recordAnswer(l.guess);
    await store.forUser(l.id).recordAnswer(l.recall);
    const before = await schedule(l.id);
    await store.forUser(l.id).recordAnswer(l.guess);
    expect(await schedule(l.id)).toEqual(before);
    const saved = await history(l.id);
    expect(saved).toHaveLength(2);
    expect(saved.find((row) => row.id === l.guess.id)?.request).toBe(request);
    await expect(
      store.forUser(l.id).recordAnswer({ ...l.guess, typed: "different" })
    ).rejects.toThrow("An answer ID cannot be reused for a different answer.");
    await expect(
      store.forUser(l.id).recordAnswer({
        ...l.guess,
        latencyMs: l.guess.latencyMs + 1,
      })
    ).rejects.toThrow("An answer ID cannot be reused for a different answer.");
    expect(await history(l.id)).toHaveLength(2);
    expect(await schedule(l.id)).toEqual(before);
  });

  it("rejects reuse of an ID with a different payload", async () => {
    const l = await learner();
    await store.forUser(l.id).recordAnswer(l.guess);
    await expect(
      store.forUser(l.id).recordAnswer({ ...l.guess, typed: "different" })
    ).rejects.toThrow(/ID/u);
  });

  it.each([0, 1])(
    "allows only one of two racing recalls against revision %i",
    async (revision) => {
      const l = await learner();
      await store.forUser(l.id).recordAnswer(l.guess);
      if (revision === 1) {
        await store.forUser(l.id).recordAnswer(l.recall);
      }
      const before = await savedProgress(l.id);
      const previousSchedule =
        revision === 0
          ? undefined
          : JSON.stringify(before.cards[0]?.fsrs_state);
      const barrier = twoWriters();
      const writer = coordinateBatches(barrier.arrive).forUser(l.id);
      const recall: AnswerCommand = {
        ...l.recall,
        expectedReps: revision,
        id: crypto.randomUUID(),
        reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
      };
      const commands: AnswerCommand[] = [
        recall,
        { ...recall, id: crypto.randomUUID(), rating: 1, typed: "wrong" },
      ];
      try {
        const results = await Promise.allSettled(
          commands.map((command) => writer.recordAnswer(command))
        );
        expect(barrier.arrivals).toBe(2);
        expect(
          results.filter((result) => result.status === "fulfilled")
        ).toHaveLength(1);
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            expect(result.reason).toBeInstanceOf(SaveConflict);
          } else {
            const winner = commands[index];
            if (!winner) {
              throw new Error("Expected the winning command.");
            }
            // Assert the one successful writer against its complete saved result.
            // eslint-disable-next-line no-await-in-loop
            await expectSavedAnswer(l.id, winner, previousSchedule);
          }
        }
        const after = await history(l.id);
        expect(after).toHaveLength(revision + 2);
        expect(
          after.filter(
            (entry) => !commands.some((command) => command.id === entry.id)
          )
        ).toEqual(before.attempts);
      } finally {
        barrier.close();
      }
    }
  );

  it("rejects a recall without its guess and leaves no schedule behind", async () => {
    const l = await learner();
    await expect(
      store.forUser(l.id).recordAnswer(l.recall)
    ).rejects.toBeInstanceOf(SaveConflict);
    expect(await history(l.id)).toHaveLength(0);
    expect(await schedule(l.id)).toHaveLength(0);
  });

  it("rejects invalid ratings, unknown fields, and unknown words", async () => {
    const l = await learner();
    // The extra owner field must reach the strict runtime parser, not be stripped by a test helper.
    const forgedOwner = { ...l.guess, userId: "someone-else" };
    await expect(
      store.forUser(l.id).recordAnswer(forgedOwner)
    ).rejects.toThrow();
    await expect(
      store.forUser(l.id).recordAnswer({ ...l.guess, wordId: "missing" })
    ).rejects.toThrow(/Word/u);
    await store.forUser(l.id).recordAnswer(l.guess);
    await expect(
      store
        .forUser(l.id)
        .recordAnswer({ ...l.recall, rating: 3, typed: "wrong" })
    ).rejects.toThrow(/Rating/u);
    await expect(
      store.forUser(l.id).recordAnswer({ ...l.recall, rating: 4 })
    ).rejects.toThrow(/Easy/u);
    expect(await history(l.id)).toHaveLength(1);
  });

  it("scopes cards, guesses, and settings by user and language", async () => {
    const a = await learner();
    const b = await learner();
    await store.forUser(a.id).recordAnswer(a.guess);
    await store.forUser(a.id).recordAnswer(a.recall);
    await fixture.db
      .insert(words)
      .values({ gloss: "cane", id: "es-word", lang: "es", text: "perro" });
    await store.forUser(a.id).recordAnswer({
      ...a.guess,
      id: crypto.randomUUID(),
      wordId: "es-word",
    });
    await store.forUser(a.id).recordAnswer({
      ...a.recall,
      id: crypto.randomUUID(),
      typed: "perro",
      wordId: "es-word",
    });
    await fixture.db.insert(settings).values({
      day_rollover_hour: 6,
      lang: "es",
      new_per_day: 7,
      user_id: a.id,
    });
    const savedCards = await schedule(a.id);
    const frenchCard = savedCards.find((card) => card.word_id === a.wordId);
    const spanishCard = savedCards.find((card) => card.word_id === "es-word");
    expect(frenchCard).toBeDefined();
    expect(spanishCard).toBeDefined();
    const aDeck = await store.forUser(a.id).snapshot("fr");
    expect(aDeck.cards).toEqual([
      { schedule: JSON.stringify(frenchCard?.fsrs_state), wordId: a.wordId },
    ]);
    expect(aDeck.guesses).toEqual([
      { reviewedAt: a.guess.reviewedAt, wordId: a.wordId },
    ]);
    const bDeck = await store.forUser(b.id).snapshot("fr");
    expect(bDeck.cards).toEqual([]);
    expect(bDeck.guesses).toEqual([]);
    expect(await store.forUser(b.id).settings()).toEqual(DEFAULT_SETTINGS);
    const aSettings = await store.forUser(a.id).settings();
    expect(aSettings).toEqual({ dayRolloverHour: 6, lang: "es", newPerDay: 7 });
    const spanish = await store.forUser(a.id).snapshot("es");
    expect(spanish.cards).toEqual([
      { schedule: JSON.stringify(spanishCard?.fsrs_state), wordId: "es-word" },
    ]);
    expect(spanish.guesses).toEqual([
      { reviewedAt: a.guess.reviewedAt, wordId: "es-word" },
    ]);
    expect(spanish.words.map((word) => word.id)).toEqual(["es-word"]);
  });

  it("enforces append-only history and protects words with history", async () => {
    const l = await learner();
    await store.forUser(l.id).recordAnswer(l.guess);
    await expect(
      fixture.db
        .update(attempts)
        .set({ typed: "tampered" })
        .where(eq(attempts.user_id, l.id))
        .run()
    ).rejects.toThrow();
    await expect(
      fixture.db.delete(attempts).where(eq(attempts.user_id, l.id)).run()
    ).rejects.toThrow();
    await expect(
      fixture.db.delete(words).where(eq(words.id, l.wordId)).run()
    ).rejects.toThrow();
    expect(await history(l.id)).toHaveLength(1);
  });

  it("does not let one user claim another user's idempotency key", async () => {
    const a = await learner();
    const b = await learner();
    await store.forUser(a.id).recordAnswer(a.guess);
    await expect(store.forUser(b.id).recordAnswer(a.guess)).rejects.toThrow();
    expect(await history(b.id)).toHaveLength(0);
  });

  it("preserves the complete checked-in catalogue including corrected punctuation", async () => {
    const source = parseCatalogue(
      JSON.parse(
        await readFile(
          new URL("../scripts/words.json", import.meta.url),
          "utf-8"
        )
      )
    );
    expect(source).toHaveLength(50);
    expect(source.filter((word) => word.kind === "chunk")).toHaveLength(15);
    await fixture.binding
      .prepare(
        "CREATE TABLE legacy_words (lang TEXT, text TEXT, gloss TEXT, hint TEXT, image TEXT, kind TEXT, freq_rank INTEGER)"
      )
      .run();
    const legacySeed = await readFile(
      new URL("../tests/fixtures/legacy-catalogue/seed.sql", import.meta.url),
      "utf-8"
    );
    await fixture.binding
      .prepare(
        legacySeed
          .slice(legacySeed.indexOf("insert into public.words"))
          .replace("public.words", "legacy_words")
          .replace(
            "on conflict on constraint words_lang_text_gloss_unique do nothing",
            ""
          )
      )
      .run();
    const punctuation = await readFile(
      new URL(
        "../tests/fixtures/legacy-catalogue/punctuation.sql",
        import.meta.url
      ),
      "utf-8"
    );
    for (const statement of punctuation
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .replaceAll("public.words", "legacy_words")
      .split(";")
      .filter((part) => part.trim())) {
      // Punctuation corrections must run in their historical SQL order.
      // eslint-disable-next-line no-await-in-loop
      await fixture.binding.prepare(statement).run();
    }
    const original = await fixture.binding
      .prepare(
        "SELECT lang, text, gloss, hint, image, kind, freq_rank FROM legacy_words ORDER BY freq_rank"
      )
      .all<
        Pick<
          typeof words.$inferSelect,
          "lang" | "text" | "gloss" | "hint" | "image" | "kind" | "freq_rank"
        >
      >();
    expect(
      source.map(({ lang, text, gloss, hint, image, kind, freq_rank }) => ({
        freq_rank,
        gloss,
        hint,
        image,
        kind,
        lang,
        text,
      }))
    ).toEqual(original.results);
    // Keep each insert below D1's bound-parameter limit.
    await Promise.all(
      source.map((word) =>
        fixture.db.insert(words).values(word).onConflictDoNothing()
      )
    );
    const stored = await fixture.db
      .select()
      .from(words)
      .where(and(eq(words.lang, "fr"), eq(words.text, "comment ça va ?")));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.gloss).toBe("come va?");
  });
});

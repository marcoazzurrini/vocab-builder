import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { testDatabase } from "../src/testing";

let fixture: Awaited<ReturnType<typeof testDatabase>>;

beforeEach(async () => {
  fixture = await testDatabase();
  await fixture.binding.batch([
    fixture.binding.prepare(
      "INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('learner','Learner','learner@example.com',1,2),('other','Other','other@example.com',1,2)"
    ),
    fixture.binding.prepare(
      "INSERT INTO words (id,lang,text,gloss) VALUES ('new','fr','chat','gatto'),('legacy','fr','chien','cane'),('rated','fr','ours','orso')"
    ),
    fixture.binding.prepare(
      "INSERT INTO attempts (id,user_id,word_id,phase,typed,correct,rating,latency_ms,state_before,reviewed_at,rep_number,request) VALUES ('legacy-guess','learner','legacy','guess','',0,NULL,1000,'{\"reps\":0}','2026-09-10T09:00:00.000Z',0,'{}')"
    ),
    fixture.binding.prepare(
      "INSERT INTO cards (user_id,word_id,revision,fsrs_state) VALUES ('learner','rated',1,'{\"reps\":1}')"
    ),
  ]);
});
afterEach(async () => {
  await fixture?.close();
});

const teaching = {
  card_type: "production",
  completed_at: "2026-09-10T09:00:00.000Z",
  id: "teaching",
  initial_recall_at: "2026-09-10T09:01:00.000Z",
  latency_ms: 1500,
  request: "{}",
  user_id: "learner",
  word_id: "new",
};

const insertTeaching = (row = teaching) =>
  fixture.binding
    .prepare(
      `INSERT INTO teachings (${Object.keys(row).join(",")}) VALUES (${Object.keys(
        row
      )
        .map(() => "?")
        .join(",")})`
    )
    .bind(...Object.values(row))
    .run();

const recall = (id: string, wordId: string, reviewedAt: string, revision = 1) =>
  fixture.binding
    .prepare(
      "INSERT INTO attempts (id,user_id,word_id,phase,typed,correct,rating,latency_ms,state_before,reviewed_at,rep_number,request) VALUES (?,'learner',?,'recall','chat',1,3,1000,'{\"reps\":0}',?,?,'{}')"
    )
    .bind(id, wordId, reviewedAt, revision);

const invalidTeachings = [
  { error: "teachings_production", patch: { card_type: "recognition" } },
  { error: "teachings_latency", patch: { latency_ms: -1 } },
  { error: "teachings_latency", patch: { latency_ms: 86_400_001 } },
  { error: "teachings_request_json", patch: { request: "not json" } },
  { error: "teachings_timestamps", patch: { completed_at: "invalid" } },
  { error: "teachings_timestamps", patch: { initial_recall_at: "invalid" } },
  {
    error: "teachings_timestamps",
    patch: { initial_recall_at: "2026-09-10T09:00:00.000Z" },
  },
  {
    error: "teachings_timestamps",
    patch: { initial_recall_at: "2026-09-10T09:01:00.001Z" },
  },
  { error: "FOREIGN KEY constraint failed", patch: { user_id: "missing" } },
  { error: "FOREIGN KEY constraint failed", patch: { word_id: "missing" } },
  { error: "stale_card_already_rated", patch: { word_id: "rated" } },
  { error: "history_id_conflict", patch: { id: "legacy-guess" } },
];

const teachingRows = async () => {
  const result = await fixture.binding.prepare("SELECT * FROM teachings").all();
  return result.results;
};

describe("teaching SQL guards", () => {
  it("rejects invalid completion evidence through raw SQL", async () => {
    await Promise.all(
      invalidTeachings.map(async ({ error, patch }) => {
        await expect(insertTeaching({ ...teaching, ...patch })).rejects.toThrow(
          error
        );
      })
    );
    expect(await teachingRows()).toEqual([]);
  });

  it("is append-only and restricts parent deletion without changing the evidence", async () => {
    await insertTeaching();
    await Promise.all(
      [
        "UPDATE teachings SET latency_ms = 0 WHERE id = 'teaching'",
        "DELETE FROM teachings WHERE id = 'teaching'",
        "INSERT OR REPLACE INTO teachings SELECT * FROM teachings WHERE id = 'teaching'",
      ].map(async (statement) => {
        await expect(fixture.binding.prepare(statement).run()).rejects.toThrow(
          "teachings_are_append_only"
        );
      })
    );
    await expect(
      fixture.binding.prepare("DELETE FROM words WHERE id = 'new'").run()
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    await expect(
      fixture.binding.prepare("DELETE FROM user WHERE id = 'learner'").run()
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    expect(await teachingRows()).toEqual([teaching]);
    const foreignKeys = await fixture.binding
      .prepare("PRAGMA foreign_key_check")
      .all();
    expect(foreignKeys.results).toEqual([]);
  });

  it("allows only one production completion per user and word", async () => {
    await insertTeaching();
    await expect(
      insertTeaching({ ...teaching, id: "different" })
    ).rejects.toThrow("teachings_are_append_only");
    await insertTeaching({
      ...teaching,
      id: "other-teaching",
      user_id: "other",
    });
    expect(await teachingRows()).toHaveLength(2);
  });

  it("guards attempt IDs against teaching IDs regardless of account", async () => {
    await insertTeaching();
    await Promise.all(
      ["learner", "other"].map(async (userId) => {
        await expect(
          fixture.binding
            .prepare(
              "INSERT INTO attempts (id,user_id,word_id,phase,typed,correct,rating,latency_ms,state_before,reviewed_at,rep_number,request) VALUES ('teaching',?,'new','guess','',0,NULL,1000,'{\"reps\":0}','2026-09-10T09:00:00.000Z',0,'{}')"
            )
            .bind(userId)
            .run()
        ).rejects.toThrow("history_id_conflict");
      })
    );
  });

  it("requires completion or a legacy guess, enforces delay and revision atomically", async () => {
    await expect(
      recall("missing", "new", teaching.initial_recall_at).run()
    ).rejects.toThrow("stale_card_missing_guess");
    await insertTeaching();
    await expect(
      recall("early", "new", "2026-09-10T09:00:59.999Z").run()
    ).rejects.toThrow("stale_card_initial_recall_not_due");
    await expect(
      recall("invalid", "new", "not a timestamp").run()
    ).rejects.toThrow("stale_card_initial_recall_not_due");
    await expect(
      recall("skipped", "new", teaching.initial_recall_at, 2).run()
    ).rejects.toThrow("stale_card_revision");
    await fixture.binding.batch([
      recall("first", "new", teaching.initial_recall_at),
      fixture.binding.prepare(
        "INSERT INTO cards (user_id,word_id,revision,fsrs_state) VALUES ('learner','new',1,'{\"reps\":1}')"
      ),
    ]);
    await expect(
      recall("stale", "new", teaching.initial_recall_at).run()
    ).rejects.toThrow("stale_card_revision");
    await recall("second", "new", "2026-09-10T09:02:00.000Z", 2).run();
  });

  it("keeps immediate legacy queued recalls valid even when teaching exists", async () => {
    await insertTeaching({ ...teaching, word_id: "legacy" });
    await recall("legacy-recall", "legacy", teaching.completed_at).run();
    expect(
      await fixture.binding
        .prepare(
          "SELECT count(*) AS count FROM attempts WHERE word_id = 'legacy'"
        )
        .first()
    ).toEqual({ count: 2 });
  });

  it("rolls back a first recall when its card write fails", async () => {
    await insertTeaching();
    await expect(
      fixture.binding.batch([
        recall("rolled-back", "new", teaching.initial_recall_at),
        fixture.binding.prepare(
          "INSERT INTO cards (user_id,word_id,revision,fsrs_state) VALUES ('learner','new',0,'{}')"
        ),
      ])
    ).rejects.toThrow("cards_revision");
    expect(
      await fixture.binding
        .prepare("SELECT id FROM attempts WHERE id = 'rolled-back'")
        .first()
    ).toBeNull();
    expect(await teachingRows()).toEqual([teaching]);
  });
});

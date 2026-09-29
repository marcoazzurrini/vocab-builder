import { AnswerCommand } from "@vocab/spaced-repetition";
import * as v from "valibot";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutbox } from "./outbox";
import { SyncConflict } from "./sync-conflict";
import { practiceWriteFetch } from "./transport";

type Send = (command: AnswerCommand) => Promise<void>;
type OnError = (error: Error) => void;

const answer = (): Extract<AnswerCommand, { phase: "guess" }> => ({
  expectedReps: 0,
  id: crypto.randomUUID(),
  latencyMs: 1,
  phase: "guess",
  rating: null,
  reviewedAt: new Date().toISOString(),
  typed: "",
  wordId: "word",
});
const storedAnswer = () =>
  v.parse(
    v.object({ answer: AnswerCommand }),
    JSON.parse(localStorage.getItem(localStorage.key(0) ?? "") ?? "null")
  ).answer;

const box = (send: Send, onError = vi.fn<OnError>(), userId = "u1") =>
  createOutbox({ onError, send, storage: () => localStorage, userId });

describe("durable answer outbox", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves the existing synchronization error contract", () => {
    const error = new SyncConflict();
    expect(error).toBeInstanceOf(Error);
    expect(error.constructor.name).toBe("SyncConflict");
    expect(error.name).toBe("Error");
    expect(String(error)).toBe(
      "Error: I progressi sono cambiati su un altro dispositivo. Le risposte in attesa non sono state salvate."
    );
    expect(JSON.stringify(error)).toBe("{}");
  });

  it("rejects a failed local write without accepting or sending the answer", async () => {
    const error = new Error("storage full");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw error;
    });
    const send = vi.fn<Send>(() => Promise.resolve());
    const onError = vi.fn<OnError>();
    const queue = box(send, onError);

    expect(() => queue.push(answer())).toThrow(error);
    expect(queue.pending).toBe(0);
    expect(localStorage).toHaveLength(0);
    await queue.settled();
    await queue.retry();
    expect(send).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts the same answer after local storage recovers", async () => {
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new Error("storage full");
      });
    const a = answer();
    const send = vi.fn<Send>((command) => {
      expect({
        command,
        stored: storedAnswer(),
      }).toStrictEqual({ command: a, stored: a });
      return Promise.resolve();
    });
    const queue = box(send);

    expect(() => queue.push(a)).toThrow("storage full");
    expect(() => queue.push(a)).not.toThrow();
    await queue.settled();
    expect(write).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect({
      pending: queue.pending,
      stored: localStorage.length,
    }).toStrictEqual({
      pending: 0,
      stored: 0,
    });
  });

  it("does not append or resend a duplicate pending answer", async () => {
    const send = vi.fn<Send>().mockRejectedValue(new Error("offline"));
    const queue = box(send);
    const a = answer();
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");
    const write = vi.spyOn(Storage.prototype, "setItem");

    // SAFETY: Reversing entries preserves every field and value of the valid AnswerCommand; only property order changes.
    queue.push(
      Object.fromEntries(Object.entries(a).toReversed()) as AnswerCommand
    );
    expect(queue.pending).toBe(1);
    expect(localStorage).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { wordId: "other-word" },
    { expectedReps: 0 as const, phase: "guess" as const, rating: null },
    { typed: "changed" },
    { rating: 1 as const },
    { latencyMs: 2 },
    { reviewedAt: "2026-01-01T00:00:00.000Z" },
    { expectedReps: 2 },
  ])("rejects a different payload for a pending ID: %j", async (change) => {
    const send = vi.fn<Send>().mockRejectedValue(new Error("offline"));
    const queue = box(send);
    const a = {
      ...answer(),
      expectedReps: 1,
      phase: "recall" as const,
      rating: 3 as const,
      reviewedAt: "2026-02-01T00:00:00.000Z",
    };
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");

    expect(() => queue.push({ ...a, ...change })).toThrow("different payload");
    expect(queue.pending).toBe(1);
    expect(storedAnswer()).toStrictEqual(a);
    expect(send).toHaveBeenCalledOnce();
  });

  it("checks duplicates against answers stored by another tab after initialization", async () => {
    const first = box(vi.fn<Send>().mockRejectedValue(new Error("offline")));
    const send = vi.fn<Send>(() => Promise.resolve());
    const second = box(send);
    const a = answer();
    first.push(a);
    await expect(first.settled()).rejects.toThrow("offline");
    const write = vi.spyOn(Storage.prototype, "setItem");

    expect(() => second.push({ ...a, typed: "changed" })).toThrow(
      "different payload"
    );
    expect(() => second.push(a)).not.toThrow();
    await second.settled();
    expect({
      pending: second.pending,
      stored: localStorage.length,
    }).toStrictEqual({
      pending: 0,
      stored: 0,
    });
    expect({ sends: send.mock.calls, writes: write.mock.calls }).toStrictEqual({
      sends: [[a]],
      writes: [],
    });
  });

  it("keeps accepted answers retryable when error notifications throw", async () => {
    const error = new Error("offline");
    const send = vi
      .fn<Send>()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValue();
    const onError = vi.fn<OnError>(() => {
      throw new Error("notification failed");
    });
    const queue = box(send, onError);
    const a = answer();

    expect(() => queue.push(a)).not.toThrow();
    await expect(queue.settled()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
    expect({
      pending: queue.pending,
      stored: localStorage.length,
    }).toStrictEqual({
      pending: 1,
      stored: 1,
    });
    await queue.retry();
    expect({
      commands: send.mock.calls.map(([command]) => command),
      pending: queue.pending,
      stored: localStorage.length,
    }).toStrictEqual({ commands: [a, a], pending: 0, stored: 0 });
  });

  it("protects the durable payload and ID from mutations by the send callback", async () => {
    const a = answer();
    const send = vi
      .fn<Send>()
      .mockImplementationOnce((command) => {
        command.id = crypto.randomUUID();
        command.wordId = "changed";
        return Promise.reject(new Error("offline"));
      })
      .mockResolvedValue();
    const queue = box(send);
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");
    expect(storedAnswer()).toStrictEqual(a);
    await queue.retry();
    expect(send.mock.calls[1]?.[0]).toStrictEqual(a);
    expect(queue.pending).toBe(0);
    expect(localStorage).toHaveLength(0);
  });

  it("includes a push made while an empty drain is completing", async () => {
    const send = vi.fn<Send>().mockResolvedValue();
    const queue = box(send);
    const settling = queue.settled();
    const a = answer();
    queue.push(a);
    await settling;
    expect(send).toHaveBeenCalledExactlyOnceWith(a);
    expect(queue.pending).toBe(0);
    expect(localStorage).toHaveLength(0);
  });

  it("includes a push made after the final acknowledgment but before drain cleanup", async () => {
    const send = vi.fn<Send>().mockResolvedValue();
    const queue = box(send);
    const a = answer();
    const b = answer();
    const remove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
      remove.call(localStorage, key);
      if (key.endsWith(a.id)) {
        queueMicrotask(() => queue.push(b));
      }
    });
    queue.push(a);
    await queue.settled();
    expect(send.mock.calls.map(([command]) => command.id)).toStrictEqual([
      a.id,
      b.id,
    ]);
    expect(queue.pending).toBe(0);
    expect(localStorage).toHaveLength(0);
  });

  it.each([
    "{broken",
    "",
    JSON.stringify({ id: "invalid" }),
    JSON.stringify({ ...answer(), outboxSequence: -1 }),
  ])(
    "preserves corrupt storage and reports it through recovery: %s",
    async (raw) => {
      const valid = answer();
      const key = `vocab-builder:answer:v1:u1:${valid.id}`;
      localStorage.setItem(key, raw);
      const send = vi.fn<Send>().mockResolvedValue();
      const onError = vi.fn<OnError>();
      const queue = box(send, onError);
      await expect(queue.settled()).rejects.toThrow(
        "Risposte salvate nel browser non valide"
      );
      await expect(queue.retry()).rejects.toThrow(
        "Risposte salvate nel browser non valide"
      );
      expect(() => queue.push(answer())).toThrow(
        "Risposte salvate nel browser non valide"
      );
      expect(() => queue.discard()).toThrow(
        "Risposte salvate nel browser non valide"
      );
      expect({
        notifications: onError.mock.calls,
        pending: queue.pending,
        sends: send.mock.calls,
        stored: localStorage.getItem(key),
      }).toStrictEqual({
        notifications: [],
        pending: 1,
        sends: [],
        stored: raw,
      });
    }
  );

  it.each(["v1", "v2"])(
    "retries repaired %s records without remounting or deleting data",
    async (version) => {
      const command = answer();
      const key = `vocab-builder:answer:${version}:u1:${command.id}`;
      localStorage.setItem(key, "{");
      const send = vi.fn<Send>().mockResolvedValue();
      const queue = box(send);
      await expect(queue.settled()).rejects.toThrow(
        "Risposte salvate nel browser non valide"
      );
      localStorage.setItem(
        key,
        JSON.stringify(
          version === "v1" ? command : { answer: command, sequence: 1 }
        )
      );
      await queue.retry();
      expect(send).toHaveBeenCalledExactlyOnceWith(command);
      expect(queue.pending).toBe(0);
      expect(localStorage).toHaveLength(0);
    }
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects an invalid durable sequence %s",
    async (sequence) => {
      const command = answer();
      const key = `vocab-builder:answer:v2:u1:${command.id}`;
      const raw = JSON.stringify({ answer: command, sequence });
      localStorage.setItem(key, raw);
      const send = vi.fn<Send>().mockResolvedValue();
      await expect(box(send).settled()).rejects.toThrow(
        "Risposte salvate nel browser non valide"
      );
      expect(send).not.toHaveBeenCalled();
      expect(localStorage.getItem(key)).toBe(raw);
    }
  );

  it("rejects a durable command whose ID does not match its storage key", async () => {
    const command = answer();
    localStorage.setItem(
      "vocab-builder:answer:v2:u1:wrong-id",
      JSON.stringify({ answer: command, sequence: 1 })
    );
    const send = vi.fn<Send>().mockResolvedValue();
    await expect(box(send).settled()).rejects.toThrow(
      "Risposte salvate nel browser non valide"
    );
    expect(send).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(1);
  });

  it("reports and rereads corruption discovered after initialization", async () => {
    const send = vi.fn<Send>().mockResolvedValue();
    const queue = box(send);
    const recovered = answer();
    const key = `vocab-builder:answer:v1:u1:${recovered.id}`;
    localStorage.setItem(key, "{");
    expect(() => queue.push(answer())).toThrow(
      "Risposte salvate nel browser non valide"
    );
    await expect(queue.settled()).rejects.toThrow(
      "Risposte salvate nel browser non valide"
    );
    expect({ pending: queue.pending, sends: send.mock.calls }).toStrictEqual({
      pending: 1,
      sends: [],
    });
    localStorage.setItem(key, JSON.stringify(recovered));
    await queue.retry();
    expect({
      pending: queue.pending,
      sends: send.mock.calls,
      stored: localStorage.length,
    }).toStrictEqual({ pending: 0, sends: [[recovered]], stored: 0 });
  });

  it("waits for an in-flight acknowledgment before rehydrating repaired storage", async () => {
    const send = vi.fn<Send>().mockResolvedValue();
    const queue = box(send);
    const first = answer();
    queue.push(first);
    const recovered = answer();
    const key = `vocab-builder:answer:v1:u1:${recovered.id}`;
    localStorage.setItem(key, "{");
    expect(() => queue.push(answer())).toThrow(
      "Risposte salvate nel browser non valide"
    );
    localStorage.setItem(key, JSON.stringify(recovered));
    // No await before retry: the first send has not acknowledged yet.
    await queue.retry();
    expect({
      pending: queue.pending,
      sends: send.mock.calls,
      stored: localStorage.length,
    }).toStrictEqual({ pending: 0, sends: [[first], [recovered]], stored: 0 });
  });

  it("does not replay a partial queue when a later record is corrupt", async () => {
    const a = answer();
    localStorage.setItem(
      `vocab-builder:answer:v1:u1:${a.id}`,
      JSON.stringify(a)
    );
    localStorage.setItem("vocab-builder:answer:v1:u1:damaged", "{");
    const send = vi.fn<Send>().mockResolvedValue();
    const queue = box(send);
    await expect(queue.settled()).rejects.toThrow(
      "Risposte salvate nel browser non valide"
    );
    expect(send).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(2);
  });

  it("replays acceptance order after clock rollback and storage enumeration changes", async () => {
    const queue = box(vi.fn<Send>().mockRejectedValue(new Error("offline")));
    const a = { ...answer(), reviewedAt: "2026-08-11T12:00:00.000Z" };
    const b = { ...answer(), reviewedAt: "2026-08-10T12:00:00.000Z" };
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");
    queue.push(b);
    await expect(queue.settled()).rejects.toThrow("offline");
    const key = `vocab-builder:answer:v2:u1:${a.id}`;
    const raw = localStorage.getItem(key);
    expect(raw).not.toBeNull();
    localStorage.removeItem(key);
    localStorage.setItem(key, raw ?? "");

    const send = vi.fn<Send>().mockResolvedValue();
    await box(send).settled();
    expect(send.mock.calls.map(([command]) => command)).toStrictEqual([a, b]);
    expect(localStorage).toHaveLength(0);
  });

  it("continues sequence numbers across remounts and accepts legacy commands first", async () => {
    const legacy = answer();
    localStorage.setItem(
      `vocab-builder:answer:v1:u1:${legacy.id}`,
      JSON.stringify(legacy)
    );
    const send = vi.fn<Send>().mockRejectedValue(new Error("offline"));
    const first = box(send);
    const a = answer();
    first.push(a);
    await expect(first.settled()).rejects.toThrow("offline");
    const second = box(send);
    const b = answer();
    second.push(b);
    await expect(second.settled()).rejects.toThrow("offline");
    const replay = vi.fn<Send>().mockResolvedValue();
    await box(replay).settled();
    expect(replay.mock.calls.map(([command]) => command)).toStrictEqual([
      legacy,
      a,
      b,
    ]);
  });

  it("preserves per-card dependencies in legacy records despite clock rollback", async () => {
    const guess = { ...answer(), reviewedAt: "2026-08-11T12:00:00.000Z" };
    const recall: AnswerCommand = {
      ...answer(),
      expectedReps: 0,
      phase: "recall",
      rating: 3,
      reviewedAt: "2026-08-10T12:00:00.000Z",
    };
    for (const command of [recall, guess]) {
      localStorage.setItem(
        `vocab-builder:answer:v1:u1:${command.id}`,
        JSON.stringify(command)
      );
    }
    const send = vi.fn<Send>().mockResolvedValue();
    await box(send).settled();
    expect(send.mock.calls.map(([command]) => command)).toStrictEqual([
      guess,
      recall,
    ]);
  });

  it("sends in order and removes only acknowledged answers", async () => {
    const sent: string[] = [];
    const queue = box((a) => {
      sent.push(a.id);
      return Promise.resolve();
    });
    const a = answer();
    const b = answer();
    queue.push(a);
    // eslint-disable-next-line unicorn/prefer-single-call -- Custom queue.push accepts one command, not Array.push's variadic arguments.
    queue.push(b);
    await queue.settled();
    expect(sent).toStrictEqual([a.id, b.id]);
    expect(queue.pending).toBe(0);
    expect(localStorage).toHaveLength(0);
  });

  it("retains a timed-out answer and retries its original payload and ID", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    request.mockImplementationOnce(
      (_input, init) =>
        // eslint-disable-next-line promise/avoid-new -- Model a request that remains pending until the write deadline expires.
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          );
        })
    );
    vi.stubGlobal("fetch", request);
    const send = vi.fn<Send>(async (command) => {
      await practiceWriteFetch("https://example.test/answer", {
        body: JSON.stringify(command),
        method: "POST",
      });
    });
    const queue = box(send);
    const command = answer();
    queue.push(command);
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(queue.settled()).rejects.toThrow("La risposta è conservata");
    expect({
      pending: queue.pending,
      saved: storedAnswer(),
      sends: send.mock.calls,
    }).toStrictEqual({ pending: 1, saved: command, sends: [[command]] });
    await queue.retry();
    expect({
      pending: queue.pending,
      sends: send.mock.calls,
      stored: localStorage.length,
    }).toStrictEqual({ pending: 0, sends: [[command], [command]], stored: 0 });
    expect(request.mock.calls[1]?.[1]?.body).toBe(
      request.mock.calls[0]?.[1]?.body
    );
  });

  it("retains failures, blocks later answers, and retries the same IDs", async () => {
    const error = new Error("network down");
    const send = vi.fn<Send>().mockRejectedValueOnce(error).mockResolvedValue();
    const onError = vi.fn<OnError>();
    const queue = box(send, onError);
    const a = answer();
    const b = answer();
    queue.push(a);
    // eslint-disable-next-line unicorn/prefer-single-call -- Custom queue.push accepts one command, not Array.push's variadic arguments.
    queue.push(b);
    await expect(queue.settled()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
    expect(send).toHaveBeenCalledOnce();
    expect({
      pending: queue.pending,
      stored: localStorage.length,
    }).toStrictEqual({
      pending: 2,
      stored: 2,
    });
    await queue.retry();
    expect({
      ids: send.mock.calls.map(([value]) => value.id),
      stored: localStorage.length,
    }).toStrictEqual({ ids: [a.id, a.id, b.id], stored: 0 });
  });

  it("restores pending answers after reload without crossing user boundaries", async () => {
    const old = box(() => Promise.reject(new Error("offline")));
    const a = answer();
    old.push(a);
    await expect(old.settled()).rejects.toThrow("offline");
    const otherUser = box(vi.fn<Send>(), vi.fn<OnError>(), "u2");
    expect(otherUser.pending).toBe(0);
    const send = vi.fn<Send>(() => Promise.resolve());
    const reloaded = box(send);
    await reloaded.settled();
    expect(send).toHaveBeenCalledWith(a);
    expect(localStorage).toHaveLength(0);
  });

  it("snapshots mutable input before background persistence", async () => {
    const send = vi.fn<Send>(() => Promise.resolve());
    const queue = box(send);
    const a = answer();
    queue.push(a);
    a.typed = "changed";
    await queue.settled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      phase: "guess",
      typed: "",
    });
  });

  it("persists and replays an unrated teaching completion after reload", async () => {
    const teaching: AnswerCommand = {
      expectedReps: 0,
      id: crypto.randomUUID(),
      latencyMs: 1000,
      phase: "teach",
      reviewedAt: new Date().toISOString(),
      wordId: "word",
    };
    const previous = box(() => Promise.reject(new Error("offline")));
    previous.push(teaching);
    await expect(previous.settled()).rejects.toThrow("offline");
    expect(storedAnswer()).toStrictEqual(teaching);
    const send = vi.fn<Send>().mockResolvedValue();
    const reloaded = box(send);
    await reloaded.settled();
    expect(send).toHaveBeenCalledExactlyOnceWith(teaching);
    expect(localStorage).toHaveLength(0);
  });

  it("does not erase another tab's pending answer", async () => {
    const first = box(() => Promise.reject(new Error("offline")));
    first.push(answer());
    await expect(first.settled()).rejects.toThrow("offline");
    // A second tab can retry the first answer safely, but an older tab cannot
    // overwrite the shared storage with its own stale copy of the entire queue.
    const second = box(() => Promise.reject(new Error("offline")));
    second.push(answer());
    await expect(second.settled()).rejects.toThrow("offline");
    expect(localStorage).toHaveLength(2);
  });
});

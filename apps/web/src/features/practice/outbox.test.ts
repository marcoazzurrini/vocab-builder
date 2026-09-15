import type { AnswerCommand } from "@vocab/spaced-repetition";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutbox } from "./outbox";
import { SyncConflict } from "./sync-conflict";

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
const box = (send: Send, onError = vi.fn<OnError>(), userId = "u1") =>
  createOutbox({ onError, send, storage: localStorage, userId });

describe("durable answer outbox", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

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
        stored: JSON.parse(
          localStorage.getItem(localStorage.key(0) ?? "") ?? "null"
        ),
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
    expect(
      JSON.parse(localStorage.getItem(localStorage.key(0) ?? "") ?? "null")
    ).toStrictEqual(a);
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
        command.typed = "changed";
        return Promise.reject(new Error("offline"));
      })
      .mockResolvedValue();
    const queue = box(send);
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");
    expect(
      JSON.parse(localStorage.getItem(localStorage.key(0) ?? "") ?? "null")
    ).toStrictEqual(a);
    await queue.retry();
    expect(send.mock.calls[1]?.[0]).toStrictEqual(a);
    expect(queue.pending).toBe(0);
    expect(localStorage).toHaveLength(0);
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
    expect(send.mock.calls[0]?.[0].typed).toBe("");
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

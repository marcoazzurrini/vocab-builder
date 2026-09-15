// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerCommand } from "@vocab/spaced-repetition";
import { createOutbox } from "./outbox";

function answer(): Extract<AnswerCommand, { phase: "guess" }> {
  return {
    id: crypto.randomUUID(),
    wordId: "word",
    phase: "guess",
    typed: "",
    rating: null,
    latencyMs: 1,
    reviewedAt: new Date().toISOString(),
    expectedReps: 0,
  };
}
const box = (send: (answer: AnswerCommand) => Promise<unknown>, onError = vi.fn(), userId = "u1") =>
  createOutbox({ userId, storage: localStorage, send, onError });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("durable answer outbox", () => {
  it("rejects a failed local write without accepting or sending the answer", async () => {
    const error = new Error("storage full");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw error;
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const queue = box(send, onError);

    expect(() => queue.push(answer())).toThrow(error);
    expect(queue.pending).toBe(0);
    expect(localStorage.length).toBe(0);
    await queue.settled();
    await queue.retry();
    expect(send).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("accepts the same answer after local storage recovers", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage full");
    });
    const a = answer();
    const send = vi.fn(async (command: AnswerCommand) => {
      expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toEqual(a);
      expect(command).toEqual(a);
    });
    const queue = box(send);

    expect(() => queue.push(a)).toThrow("storage full");
    expect(() => queue.push(a)).not.toThrow();
    await queue.settled();
    expect(write).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(queue.pending).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("does not append or resend a duplicate pending answer", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const queue = box(send);
    const a = answer();
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");
    const write = vi.spyOn(Storage.prototype, "setItem");

    // Property order is not part of the payload's identity.
    queue.push(Object.fromEntries(Object.entries(a).reverse()) as AnswerCommand);
    expect(queue.pending).toBe(1);
    expect(localStorage.length).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { wordId: "other-word" },
    { phase: "guess" as const, rating: null, expectedReps: 0 as const },
    { typed: "changed" },
    { rating: 1 as const },
    { latencyMs: 2 },
    { reviewedAt: "2026-01-01T00:00:00.000Z" },
    { expectedReps: 2 },
  ])("rejects a different payload for a pending ID: %j", async (change) => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const queue = box(send);
    const a = {
      ...answer(),
      phase: "recall" as const,
      rating: 3 as const,
      expectedReps: 1,
      reviewedAt: "2026-02-01T00:00:00.000Z",
    };
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");

    expect(() => queue.push({ ...a, ...change })).toThrow("different payload");
    expect(queue.pending).toBe(1);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toEqual(a);
    expect(send).toHaveBeenCalledOnce();
  });

  it("checks duplicates against answers stored by another tab after initialization", async () => {
    const first = box(vi.fn().mockRejectedValue(new Error("offline")));
    const send = vi.fn().mockResolvedValue(undefined);
    const second = box(send);
    const a = answer();
    first.push(a);
    await expect(first.settled()).rejects.toThrow("offline");
    const write = vi.spyOn(Storage.prototype, "setItem");

    expect(() => second.push({ ...a, typed: "changed" })).toThrow("different payload");
    expect(() => second.push(a)).not.toThrow();
    await second.settled();
    expect(second.pending).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(a);
    expect(localStorage.length).toBe(0);
  });

  it("keeps accepted answers retryable when error notifications throw", async () => {
    const error = new Error("offline");
    const send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValue(undefined);
    const onError = vi.fn(() => {
      throw new Error("notification failed");
    });
    const queue = box(send, onError);
    const a = answer();

    expect(() => queue.push(a)).not.toThrow();
    await expect(queue.settled()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
    expect(queue.pending).toBe(1);
    expect(localStorage.length).toBe(1);
    await queue.retry();
    expect(send.mock.calls.map(([command]) => command)).toEqual([a, a]);
    expect(queue.pending).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("protects the durable payload and ID from mutations by the send callback", async () => {
    const a = answer();
    const send = vi
      .fn()
      .mockImplementationOnce(async (command: AnswerCommand) => {
        command.id = crypto.randomUUID();
        command.typed = "changed";
        throw new Error("offline");
      })
      .mockResolvedValue(undefined);
    const queue = box(send);
    queue.push(a);
    await expect(queue.settled()).rejects.toThrow("offline");
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toEqual(a);
    await queue.retry();
    expect(send.mock.calls[1]![0]).toEqual(a);
    expect(queue.pending).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("sends in order and removes only acknowledged answers", async () => {
    const sent: string[] = [];
    const queue = box(async (a) => {
      sent.push(a.id);
    });
    const a = answer(),
      b = answer();
    queue.push(a);
    queue.push(b);
    await queue.settled();
    expect(sent).toEqual([a.id, b.id]);
    expect(queue.pending).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("retains failures, blocks later answers, and retries the same IDs", async () => {
    const error = new Error("network down");
    const send = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const queue = box(send, onError);
    const a = answer(),
      b = answer();
    queue.push(a);
    queue.push(b);
    await expect(queue.settled()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
    expect(send).toHaveBeenCalledOnce();
    expect(queue.pending).toBe(2);
    expect(localStorage.length).toBe(2);
    await queue.retry();
    expect(send.mock.calls.map(([value]) => value.id)).toEqual([a.id, a.id, b.id]);
    expect(localStorage.length).toBe(0);
  });

  it("restores pending answers after reload without crossing user boundaries", async () => {
    const old = box(async () => {
      throw new Error("offline");
    });
    const a = answer();
    old.push(a);
    await expect(old.settled()).rejects.toThrow();
    const otherUser = box(vi.fn(), vi.fn(), "u2");
    expect(otherUser.pending).toBe(0);
    const send = vi.fn().mockResolvedValue(undefined);
    const reloaded = box(send);
    await reloaded.settled();
    expect(send).toHaveBeenCalledWith(a);
    expect(localStorage.length).toBe(0);
  });

  it("snapshots mutable input before background persistence", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = box(send);
    const a = answer();
    queue.push(a);
    a.typed = "changed";
    await queue.settled();
    expect(send.mock.calls[0]![0].typed).toBe("");
  });

  it("does not erase another tab's pending answer", async () => {
    const first = box(async () => {
      throw new Error("offline");
    });
    first.push(answer());
    await expect(first.settled()).rejects.toThrow();
    // A second tab can retry the first answer safely, but an older tab cannot
    // overwrite the shared storage with its own stale copy of the entire queue.
    const second = box(async () => {
      throw new Error("offline");
    });
    second.push(answer());
    await expect(second.settled()).rejects.toThrow();
    expect(localStorage.length).toBe(2);
  });
});

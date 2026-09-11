// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnswerCommand } from "./commands";
import { createOutbox } from "./outbox";

function answer(): AnswerCommand {
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

describe("durable answer outbox", () => {
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

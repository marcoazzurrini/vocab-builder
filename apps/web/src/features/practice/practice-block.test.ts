import type { SessionView } from "@vocab/spaced-repetition";
import { describe, expect, it, vi } from "vitest";

import { createPracticeBlock } from "./practice-block";

const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
const recall: SessionView = {
  efforts: ["good"],
  phase: "recall",
  prompt: { gloss: "cane", hint: null, image: null, kind: "word" },
};
const feedback: SessionView = {
  expected: "chien",
  phase: "feedback",
  typed: "chat",
};
const stats = { correct: 0, introduced: 0, recalls: 0, wrong: 0 };
const caughtUp: SessionView = {
  nextDueAt: new Date(60_000),
  phase: "caughtUp",
  stats,
};
const create = () => {
  const memory = storage();
  const block = createPracticeBlock("u1", () => memory);
  block.configure("fr");
  return { block, memory };
};

describe("the active practice time goal", () => {
  it("starts explicitly with an adjustable five-minute goal", () => {
    const { block } = create();
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 0,
      phase: "setup",
      preferences: { minutes: 5 },
    });
    block.updateActivity(true, 0);
    block.updateActivity(true, 10_000);
    expect(block.getSnapshot().elapsedMs).toBe(0);
    block.setMinutes(3);
    block.start();
    expect(block.getSnapshot()).toMatchObject({
      phase: "running",
      preferences: { minutes: 3 },
    });
    block.setMinutes(10);
    expect(block.getSnapshot().preferences.minutes).toBe(3);
  });

  it("counts quiet reading but not hidden, loading, or recovery time", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(false, 20_000);
    block.updateActivity(false, 100_000);
    block.updateActivity(true, 200_000);
    block.updateActivity(true, 210_000);
    expect(block.getSnapshot().elapsedMs).toBe(30_000);
  });

  it("preserves elapsed time across a manual pause", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.pause(30_000);
    block.updateActivity(true, 200_000);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 30_000,
      phase: "paused",
    });
    block.resume();
    block.updateActivity(true, 300_000);
    block.updateActivity(true, 310_000);
    expect(block.getSnapshot().elapsedMs).toBe(40_000);
  });

  it("does not interrupt an answer or corrective feedback at the time goal", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 500_000);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 300_000,
      phase: "running",
    });
    block.settle(feedback);
    expect(block.getSnapshot().phase).toBe("running");
    block.settle(recall);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 300_000,
      phase: "complete",
      reason: "goal",
    });
  });

  it("keeps overdue feedback available after pausing and resuming", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.pause(300_000);
    block.resume();
    block.settle(feedback);
    expect(block.getSnapshot().phase).toBe("running");
    block.settle(recall);
    expect(block.getSnapshot().phase).toBe("complete");
  });

  it("does not reset progress after a wrong answer", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 40_000);
    block.settle(feedback);
    block.settle(recall);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 40_000,
      phase: "running",
      preferences: { minutes: 5 },
    });
  });

  it("ends early when nothing is due without starting again automatically", () => {
    const { block } = create();
    block.start();
    block.settle(caughtUp);
    expect(block.getSnapshot()).toMatchObject({
      phase: "complete",
      reason: "caughtUp",
    });
    block.updateActivity(true, 10_000);
    block.updateActivity(true, 700_000);
    block.settle(recall);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 0,
      phase: "complete",
    });
    block.start();
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 0,
      phase: "running",
      reason: null,
    });
  });

  it("finishes a depleted queue without claiming the entire day is finished", () => {
    const { block } = create();
    block.start();
    block.settle({ phase: "done", stats });
    expect(block.getSnapshot()).toMatchObject({
      phase: "complete",
      reason: "done",
    });
    block.dismiss();
    expect(block.getSnapshot().phase).toBe("setup");
  });

  it("allows an early voluntary finish", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.finish(13_000);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 13_000,
      phase: "complete",
      reason: "stopped",
    });
  });

  it("admits new words conservatively and never requests learn-ahead", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 210_000);
    expect(block.policy()).toStrictEqual({ allowNew: true, dueOnly: true });
    block.updateActivity(true, 210_001);
    expect(block.policy()).toStrictEqual({ allowNew: false, dueOnly: true });
  });

  it("restores progress and preferences paused without counting time away", () => {
    const { block, memory } = create();
    block.setMinutes(10);
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 70_000);
    const restored = createPracticeBlock("u1", () => memory);
    restored.configure("fr");
    expect(restored.getSnapshot()).toMatchObject({
      elapsedMs: 70_000,
      phase: "paused",
      preferences: { minutes: 10 },
    });
    restored.updateActivity(true, 800_000);
    expect(restored.getSnapshot().elapsedMs).toBe(70_000);
  });

  it("restores older timers without the removed clock preference", () => {
    const { block, memory } = create();
    memory.setItem(
      "vocab:practice-block:v1:u1:fr",
      JSON.stringify({
        ...block.getSnapshot(),
        elapsedMs: 60_000,
        phase: "running",
        preferences: { minutes: 3, showClock: false },
      })
    );
    const restored = createPracticeBlock("u1", () => memory);
    restored.configure("fr");
    expect(restored.getSnapshot()).toMatchObject({
      elapsedMs: 60_000,
      phase: "paused",
    });
    expect(restored.getSnapshot().preferences).toStrictEqual({ minutes: 3 });
  });

  it("isolates timer state by account and learning language", () => {
    const { block, memory } = create();
    block.setMinutes(3);
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 10_000);
    const other = createPracticeBlock("u2", () => memory);
    other.configure("fr");
    expect(other.getSnapshot()).toMatchObject({ elapsedMs: 0, phase: "setup" });
    block.configure("en");
    expect(block.getSnapshot()).toMatchObject({ elapsedMs: 0, phase: "setup" });
    block.configure("fr");
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 10_000,
      phase: "paused",
      preferences: { minutes: 3 },
    });
  });

  it("does not reset a running block when its snapshot reloads", () => {
    const { block } = create();
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 20_000);
    block.configure("fr");
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 20_000,
      phase: "running",
    });
  });

  it("recovers malformed optional timer data without touching answer storage", () => {
    const memory = storage();
    memory.setItem("vocab-builder:answer:v1:pending", "answer");
    memory.setItem("vocab:practice-block:v1:u1:fr", "not JSON");
    const block = createPracticeBlock("u1", () => memory);
    block.configure("fr");
    expect(block.getSnapshot().phase).toBe("setup");
    expect(memory.getItem("vocab-builder:answer:v1:pending")).toBe("answer");
  });

  it("does not let a stale paused tab overwrite a completed block", () => {
    const { block, memory } = create();
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 20_000);
    const other = createPracticeBlock("u1", () => memory);
    other.configure("fr");
    expect(other.getSnapshot().phase).toBe("paused");
    expect(
      JSON.parse(memory.getItem("vocab:practice-block:v1:u1:fr") ?? "{}").phase
    ).toBe("running");
    block.finish(30_000);
    other.resume();
    expect(other.getSnapshot()).toMatchObject({
      elapsedMs: 30_000,
      phase: "complete",
    });
    const restored = createPracticeBlock("u1", () => memory);
    restored.configure("fr");
    expect(restored.getSnapshot()).toMatchObject({
      elapsedMs: 30_000,
      phase: "complete",
    });
  });

  it("adopts other-tab updates without starting a second clock", () => {
    const { block, memory } = create();
    const other = createPracticeBlock("u1", () => memory);
    other.configure("fr");
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 20_000);
    other.sync();
    expect(other.getSnapshot()).toMatchObject({
      elapsedMs: 20_000,
      phase: "paused",
    });
    block.finish(30_000);
    other.sync();
    expect(other.getSnapshot()).toMatchObject({
      elapsedMs: 30_000,
      phase: "complete",
    });
  });

  it("surfaces optional timer storage failures without throwing", () => {
    const block = createPracticeBlock("u1", () => {
      throw new Error("unavailable");
    });
    block.configure("fr");
    block.start();
    block.updateActivity(true, 0);
    block.updateActivity(true, 20_000);
    expect(block.getSnapshot()).toMatchObject({
      elapsedMs: 20_000,
      phase: "running",
      storageUnavailable: true,
    });
  });

  it("publishes stable snapshots only when progress changes", () => {
    const { block } = create();
    const notify = vi.fn<() => void>();
    const unsubscribe = block.subscribe(notify);
    const initial = block.getSnapshot();
    block.updateActivity(false, 1000);
    expect(block.getSnapshot()).toBe(initial);
    expect(notify).not.toHaveBeenCalled();
    block.start();
    expect(notify).toHaveBeenCalledOnce();
    unsubscribe();
    block.finish(2000);
    expect(notify).toHaveBeenCalledOnce();
  });
});

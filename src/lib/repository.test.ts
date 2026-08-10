import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it, vi } from "vitest";
import { createWriteQueue, reviveFsrsCard, toCard, toWord } from "./repository";

describe("row mapping", () => {
  it("maps a word row to the session's shape", () => {
    expect(
      toWord({
        id: "w1",
        text: "fenêtre",
        gloss: "finestra",
        hint: null,
        image: "🪟",
        kind: "word",
        freq_rank: 12,
      }),
    ).toEqual({
      id: "w1",
      text: "fenêtre",
      gloss: "finestra",
      hint: null,
      image: "🪟",
      kind: "word",
      freqRank: 12,
    });
  });
});

describe("reviving FSRS state from jsonb", () => {
  // The failure this guards against is silent: ts-fsrs would do date arithmetic
  // on strings and schedule wrongly without raising anything.
  it("turns date strings back into Dates", () => {
    const original = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    const roundTripped = reviveFsrsCard(JSON.parse(JSON.stringify(original)));

    expect(roundTripped.due).toBeInstanceOf(Date);
    expect(roundTripped.due.getTime()).toBe(original.due.getTime());
  });

  it("survives a full round trip through a card row", () => {
    const fsrs = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    const card = toCard({
      id: "c1",
      word_id: "w1",
      fsrs_state: JSON.parse(JSON.stringify(fsrs)),
      due: fsrs.due.toISOString(),
    });

    expect(card.fsrs.due).toBeInstanceOf(Date);
    expect(card.fsrs.state).toBe(fsrs.state);
    expect(card.fsrs.reps).toBe(fsrs.reps);
  });

  it("leaves last_review undefined when the card has never been reviewed", () => {
    const revived = reviveFsrsCard(JSON.parse(JSON.stringify(createEmptyCard(new Date()))));
    expect(revived.last_review).toBeUndefined();
  });

  it("revives last_review once it exists", () => {
    const reviewed = { ...createEmptyCard(new Date()), last_review: new Date() };
    const revived = reviveFsrsCard(JSON.parse(JSON.stringify(reviewed)));
    expect(revived.last_review).toBeInstanceOf(Date);
  });
});

describe("write queue", () => {
  it("runs tasks in the order they were pushed", async () => {
    // A card insert must land before the attempt whose foreign key points at it.
    const order: number[] = [];
    const queue = createWriteQueue(() => {});
    queue.push(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    queue.push(async () => {
      order.push(2);
    });
    await queue.settled();
    expect(order).toEqual([1, 2]);
  });

  it("reports a failure instead of swallowing it", async () => {
    const onError = vi.fn();
    const queue = createWriteQueue(onError);
    queue.push(async () => {
      throw new Error("network down");
    });
    await queue.settled();
    expect(onError).toHaveBeenCalledWith("network down");
  });

  it("keeps going after a failure", async () => {
    const onError = vi.fn();
    const done: string[] = [];
    const queue = createWriteQueue(onError);
    queue.push(async () => {
      throw new Error("boom");
    });
    queue.push(async () => {
      done.push("after");
    });
    await queue.settled();
    expect(done).toEqual(["after"]);
    expect(onError).toHaveBeenCalledOnce();
  });
});

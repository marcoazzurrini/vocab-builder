import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeck,
  CardAlreadyExistsError,
  createWriteQueue,
  reviveFsrsCard,
  toCard,
  toWord,
} from "./repository";
import type { CardRow, WordRow } from "./repository";

const NOW = new Date("2026-08-10T09:00:00");

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
      created_at: NOW.toISOString(),
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

  it("defaults learning_steps, which older rows predate", () => {
    const { learning_steps: _, ...withoutSteps } = createEmptyCard(NOW);
    expect(reviveFsrsCard(JSON.parse(JSON.stringify(withoutSteps))).learning_steps).toBe(0);
  });

  it("passes through fields it does not know, so an upstream addition survives", () => {
    // ts-fsrs added learning_steps once already. When it adds the next field,
    // stripping it here would quietly corrupt every card on every load.
    const withNewField = { ...JSON.parse(JSON.stringify(createEmptyCard(NOW))), decay: 0.2 };
    const revived = reviveFsrsCard(withNewField) as unknown as Record<string, unknown>;
    expect(revived.decay).toBe(0.2);
  });

  describe("refusing state it cannot read", () => {
    // Each of these used to pass straight through the cast and become a wrong
    // schedule that never raised anything.
    const valid = () => JSON.parse(JSON.stringify(createEmptyCard(NOW))) as Record<string, unknown>;

    it("rejects an unparseable due date", () => {
      expect(() => reviveFsrsCard({ ...valid(), due: "soon" })).toThrow(/unreadable/i);
    });

    it("rejects a missing due date", () => {
      const { due: _, ...noDue } = valid();
      expect(() => reviveFsrsCard(noDue)).toThrow(/unreadable/i);
    });

    it("rejects a stability that arrived as a string", () => {
      expect(() => reviveFsrsCard({ ...valid(), stability: "3.4" })).toThrow(/unreadable/i);
    });

    it("rejects NaN, which JSON writes as null", () => {
      expect(() => reviveFsrsCard({ ...valid(), difficulty: null })).toThrow(/unreadable/i);
    });

    it("rejects a state outside the enum", () => {
      expect(() => reviveFsrsCard({ ...valid(), state: 7 })).toThrow(/unreadable/i);
    });

    it("rejects a negative reps count", () => {
      expect(() => reviveFsrsCard({ ...valid(), reps: -1 })).toThrow(/unreadable/i);
    });

    it("names the card, so the row can be found and rebuilt", () => {
      expect(() => reviveFsrsCard({ ...valid(), due: "soon" }, "card-42")).toThrow(/card-42/);
    });
  });
});

describe("building the deck", () => {
  const words: WordRow[] = [
    {
      id: "w1",
      text: "chien",
      gloss: "cane",
      hint: null,
      image: "🐶",
      kind: "word",
      freq_rank: 1,
    },
  ];

  function cardRow(id: string, createdAt: Date): CardRow {
    return {
      id,
      word_id: "w1",
      fsrs_state: JSON.parse(JSON.stringify(createEmptyCard(createdAt))),
      created_at: createdAt.toISOString(),
    };
  }

  it("marks a card guessed when attempts say so, and not otherwise", () => {
    // FSRS state cannot answer this — guesses are never rated — so the only
    // honest source is the attempts table.
    const deck = buildDeck(words, [cardRow("c1", NOW), cardRow("c2", NOW)], ["c1"], NOW);
    expect(deck.cards.map((c) => c.guessed)).toEqual([true, false]);
  });

  it("counts only cards created since midnight toward the allowance", () => {
    // Counted from the cards themselves rather than tracked separately, so
    // reopening the app mid-day resumes the allowance instead of restarting it.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const deck = buildDeck(words, [cardRow("c1", yesterday), cardRow("c2", NOW)], [], NOW);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts one created a minute after midnight", () => {
    const justAfterMidnight = new Date("2026-08-10T00:01:00");
    const deck = buildDeck(words, [cardRow("c1", justAfterMidnight)], [], NOW);
    expect(deck.introducedToday).toBe(1);
  });

  it("revives the dates jsonb threw away", () => {
    const deck = buildDeck(words, [cardRow("c1", NOW)], [], NOW);
    expect(deck.cards[0]!.fsrs.due).toBeInstanceOf(Date);
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
    const boom = new Error("network down");
    queue.push(async () => {
      throw boom;
    });
    await queue.settled();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("hands over the error itself, since one kind is acted on rather than shown", async () => {
    const onError = vi.fn();
    const queue = createWriteQueue(onError);
    queue.push(async () => {
      throw new CardAlreadyExistsError("w1");
    });
    await queue.settled();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(CardAlreadyExistsError);
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

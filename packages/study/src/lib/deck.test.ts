import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import { buildDeck, reviveFsrsCard, toCard, toWord } from "./deck";
import type { CardRow, GuessRow, WordRow } from "./deck";

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
      word_id: "w1",
      fsrs_state: JSON.parse(JSON.stringify(fsrs)),
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

  function cardRow(wordId: string): CardRow {
    return {
      word_id: wordId,
      fsrs_state: JSON.parse(JSON.stringify(createEmptyCard(NOW))),
    };
  }

  function guess(wordId: string, at: Date): GuessRow {
    return { word_id: wordId, reviewed_at: at.toISOString() };
  }

  it("builds an awaiting card from a guess with no card row", () => {
    // A guess with no card is a word introduced but never rated — the app
    // closed between the exposure and the first recall. The card is rebuilt
    // from the attempt that defines the stage.
    const deck = buildDeck(words, [], [guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
    expect(deck.cards[0]!.wordId).toBe("w1");
    expect(deck.cards[0]!.fsrs.reps).toBe(0);
  });

  it("does not double a word that has both a guess and a card row", () => {
    const deck = buildDeck(words, [cardRow("w1")], [guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
  });

  it("tolerates the same guess arriving from both queries", () => {
    // The awaiting query and the today query can overlap; one guess per word
    // makes deduplication exact.
    const deck = buildDeck(words, [], [guess("w1", NOW), guess("w1", NOW)], NOW);
    expect(deck.cards).toHaveLength(1);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts only words guessed since midnight toward the allowance", () => {
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const deck = buildDeck(words, [], [guess("w1", yesterday), guess("w2", NOW)], NOW);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts one guessed a minute after midnight", () => {
    const justAfterMidnight = new Date("2026-08-10T00:01:00");
    const deck = buildDeck(words, [], [guess("w1", justAfterMidnight)], NOW);
    expect(deck.introducedToday).toBe(1);
  });

  it("counts a small-hours guess as yesterday's when the day rolls over at four", () => {
    // A 00:30 sitting is still yesterday's sitting: its guesses must not
    // come out of the new day's allowance.
    const halfPastMidnight = new Date("2026-08-10T00:30:00");
    const deck = buildDeck(words, [], [guess("w1", halfPastMidnight)], NOW, 4);
    expect(deck.introducedToday).toBe(0);
  });

  it("revives the dates jsonb threw away", () => {
    const deck = buildDeck(words, [cardRow("w1")], [], NOW);
    expect(deck.cards[0]!.fsrs.due).toBeInstanceOf(Date);
  });
});

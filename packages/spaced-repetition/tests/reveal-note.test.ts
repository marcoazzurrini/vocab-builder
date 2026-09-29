import { expect, it } from "bun:test";

import { createSession } from "../src/index";
import type { EntryPresentation, ReviewSnapshot } from "../src/index";

it("shows form explanations during teaching and feedback, never in a recall prompt", () => {
  const presentation: EntryPresentation = {
    context: "prima persona",
    example: { text: "Je suis ici.", translation: "Sono qui." },
    explanation: "Con je: je suis.",
    grammar: "presente",
    meaning: "sono",
  };
  const snapshot: ReviewSnapshot = {
    cards: [],
    guesses: [],
    words: [
      {
        freqRank: 1,
        gloss: "sono (io; verbo essere)",
        hint: null,
        id: "suis-form",
        image: null,
        kind: "word",
        presentation,
        revealNote: "Con je: je suis.",
        text: "suis",
      },
    ],
  };
  const now = new Date("2026-09-20T10:00:00.000Z");
  const session = createSession({ clock: () => now, snapshot });
  expect(session.view).toMatchObject({
    answer: "suis",
    phase: "exposure",
    presentation,
    revealNote: "Con je: je suis.",
  });
  const { view } = session;
  if (view.phase !== "exposure" || !view.presentation?.example) {
    throw new Error("Missing teaching presentation");
  }
  view.presentation.example.text = "mutated";
  expect(session.view).toMatchObject({ presentation });
  session.exposureDone();
  const due = new Date(now.getTime() + 60_000);
  const resumed = createSession({
    clock: () => due,
    snapshot: {
      ...snapshot,
      teachings: [
        {
          initialRecallAt: due.toISOString(),
          reviewedAt: now.toISOString(),
          wordId: "suis-form",
        },
      ],
    },
  });
  expect(resumed.view).toEqual({
    efforts: ["hard", "good"],
    phase: "recall",
    prompt: {
      context: "prima persona",
      gloss: "sono (io; verbo essere)",
      grammar: "presente",
      hint: null,
      image: null,
      kind: "word",
      meaning: "sono",
    },
  });
  expect(JSON.stringify(resumed.view)).not.toContain("je suis");
  expect(JSON.stringify(resumed.view)).not.toContain("Je suis ici.");
  expect(resumed.view).not.toHaveProperty("presentation");
  resumed.submitRecall("être", "good");
  expect(resumed.view).toMatchObject({
    expected: "suis",
    phase: "feedback",
    presentation,
    revealNote: "Con je: je suis.",
  });
});

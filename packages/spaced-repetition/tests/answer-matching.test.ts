import { describe, expect, it } from "bun:test";

import * as fc from "fast-check";

import { matches, normalise } from "../src/answer-matching";

// One rule: orthography is graded, typography is not.
describe("answer matching", () => {
  describe("graded — a mismatch is wrong", () => {
    it("rejects a missing accent", () => {
      // fenetre is not a French word. This is the whole reason the rule exists.
      expect(matches("fenetre", "fenêtre")).toBe(false);
    });

    it("rejects the wrong accent", () => {
      expect(matches("fenètre", "fenêtre")).toBe(false);
    });

    it("rejects a different word", () => {
      expect(matches("chat", "chien")).toBe(false);
    });

    it("rejects reordered words in a chunk", () => {
      expect(matches("ne je sais pas", "je ne sais pas")).toBe(false);
    });

    it("rejects an empty answer", () => {
      expect(matches("", "chien")).toBe(false);
    });
  });

  describe("normalised away — typing, not French", () => {
    it("ignores case", () => {
      expect(matches("Chien", "chien")).toBe(true);
    });

    it("ignores surrounding whitespace", () => {
      expect(matches("  chien  ", "chien")).toBe(true);
    });

    it("accepts oe for the œ ligature", () => {
      expect(matches("coeur", "cœur")).toBe(true);
    });

    it("accepts the ligature itself", () => {
      expect(matches("cœur", "cœur")).toBe(true);
    });

    it("accepts either apostrophe", () => {
      expect(matches("qu’est-ce que c’est", "qu'est-ce que c'est ?")).toBe(
        true
      );
      expect(matches("qu'est-ce que c'est", "qu’est-ce que c’est ?")).toBe(
        true
      );
    });

    it("ignores a missing question mark", () => {
      expect(matches("comment ça va", "comment ça va ?")).toBe(true);
    });

    it("ignores the French space before the question mark", () => {
      expect(matches("comment ça va?", "comment ça va ?")).toBe(true);
    });

    it("collapses doubled spaces inside a chunk", () => {
      expect(matches("je  ne   sais pas", "je ne sais pas")).toBe(true);
    });

    it("accepts an accent that arrived decomposed", () => {
      // Identical on screen, different strings. Pasted text is the usual source.
      const decomposed = "fenêtre".normalize("NFD");
      expect(decomposed).not.toBe("fenêtre");
      expect(matches(decomposed, "fenêtre")).toBe(true);
    });

    it("accepts a decomposed expected answer too", () => {
      expect(matches("fenêtre", "fenêtre".normalize("NFD"))).toBe(true);
    });

    it("accepts the other single quotes a keyboard might emit", () => {
      for (const apostrophe of ["'", "’", "‘", "ʼ", "´", "`", "′"]) {
        expect(
          matches(`qu${apostrophe}est-ce que c'est`, "qu'est-ce que c'est ?")
        ).toBe(true);
      }
    });
  });

  describe("normalise", () => {
    it("is idempotent", () => {
      const once = normalise("  Qu’est-ce que  C'EST ?  ");
      expect(normalise(once)).toBe(once);
    });

    it("keeps accents while stripping everything else", () => {
      expect(normalise("  COMBIEN ça  COÛTE ?  ")).toBe("combien ça coûte");
    });

    it("removes all supported terminal punctuation and intervening whitespace in one pass", () => {
      expect(normalise("bonjour ! ?")).toBe("bonjour");
      expect(normalise("bonjour.\t!\n?\u00A0.\u202F")).toBe("bonjour");
      expect(normalise(" !\t?\n. ")).toBe("");
    });

    it("preserves interior punctuation, accents, and unsupported terminal punctuation", () => {
      expect(normalise("  Écoute ! Ça va ? Oui... très bien ! ? ")).toBe(
        "écoute ! ça va ? oui... très bien"
      );
      expect(normalise("où, ça; là: peut-être…")).toBe(
        "où, ça; là: peut-être…"
      );
      expect(matches("ça!va", "çava")).toBe(false);
    });

    it("composes accents exposed by ligature expansion", () => {
      expect(normalise("Œ\u0301 ! ?")).toBe("oé");
      expect(matches("œ\u0301", "oe\u0301")).toBe(true);
      expect(matches("œ\u0301", "oe")).toBe(false);
    });
  });

  describe("generated normalization invariants", () => {
    const text = fc.oneof(
      fc.string(),
      fc
        .array(
          fc.oneof(
            fc
              .integer({ max: 0x10_ff_ff, min: 0 })
              .map((codePoint) => String.fromCodePoint(codePoint)),
            fc.constantFrom(
              "œ",
              "Œ",
              "é",
              "e\u0301",
              "\u0301",
              "’",
              "!",
              "?",
              ".",
              " ",
              "\t",
              "\n",
              "\u00A0",
              "\u202F"
            )
          ),
          { maxLength: 80 }
        )
        .map((characters) => characters.join(""))
    );
    const suffix = fc
      .array(
        fc.constantFrom(
          "!",
          "?",
          ".",
          " ",
          "\t",
          "\n",
          "\r",
          "\u00A0",
          "\u202F"
        ),
        {
          maxLength: 40,
        }
      )
      .map((characters) => characters.join(""));

    it("is idempotent, NFC-composed, and whitespace-normalized", () => {
      fc.assert(
        fc.property(text, (input) => {
          const output = normalise(input);
          expect(normalise(output)).toBe(output);
          expect(output.normalize("NFC")).toBe(output);
          expect(output.trim()).toBe(output);
          expect(output).not.toMatch(/\s{2}|[^\S ]|[?!.\s]$/u);
        }),
        { numRuns: 500 }
      );
    });

    it("ignores arbitrary supported terminal punctuation and whitespace", () => {
      fc.assert(
        fc.property(text, suffix, (input, ending) => {
          expect(normalise(input + ending)).toBe(normalise(input));
        }),
        { numRuns: 500 }
      );
    });

    it("matches canonical Unicode equivalents and compares symmetrically", () => {
      fc.assert(
        fc.property(text, text, (left, right) => {
          expect(matches(left, left.normalize("NFD"))).toBe(true);
          expect(matches(left, right)).toBe(matches(right, left));
        }),
        { numRuns: 500 }
      );
    });

    it("preserves generated interior punctuation and distinguishes accents", () => {
      const prefix = fc
        .array(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 20 })
        .map((letters) => letters.join(""));
      const accent = fc.constantFrom(
        ["é", "e"],
        ["è", "e"],
        ["ê", "e"],
        ["à", "a"],
        ["â", "a"],
        ["î", "i"],
        ["ô", "o"],
        ["ù", "u"],
        ["û", "u"],
        ["ç", "c"]
      );
      fc.assert(
        fc.property(
          prefix,
          accent,
          fc.constantFrom("!", "?", ".", ",", ";", ":", "-", "'"),
          (beginning, [accented, plain], punctuation) => {
            const word = `${beginning}${accented}${punctuation}mot`;
            expect(normalise(word)).toBe(word);
            expect(matches(word, `${beginning}${plain}${punctuation}mot`)).toBe(
              false
            );
            expect(matches(word, `${beginning}${accented}mot`)).toBe(false);
          }
        ),
        { numRuns: 500 }
      );
    });
  });
});

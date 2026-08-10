import { describe, expect, it } from "vitest";
import { matches, normalise } from "./matching";

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
      expect(matches("qu’est-ce que c’est", "qu'est-ce que c'est ?")).toBe(true);
      expect(matches("qu'est-ce que c'est", "qu’est-ce que c’est ?")).toBe(true);
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
        expect(matches(`qu${apostrophe}est-ce que c'est`, "qu'est-ce que c'est ?")).toBe(true);
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
  });
});

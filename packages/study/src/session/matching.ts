/**
 * Answer comparison. One rule decides everything here:
 * **orthography is graded, typography is not.**
 *
 * A missing accent changes the word — `fenetre` is not French. A ligature, the
 * apostrophe your keyboard happened to emit, or a space before a question mark
 * changes nothing about whether you know the word.
 */

/** `'` and friends. Phone and desktop keyboards disagree about which they emit. */
const APOSTROPHES = /[’‘ʼʹ´`′]/g;

/** Stored and shown for TTS prosody (§7), never typed by the user. */
const TERMINAL_PUNCTUATION = /[?!.]+$/;

export function normalise(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      // Compose the accents before comparing them.
      //
      // `ê` can arrive as one character or as `e` followed by a combining
      // circumflex, and the two are different strings that render identically.
      // Everything in this module turns on accents being graded strictly, and
      // wrong answers are shown without diff highlighting on purpose — so
      // without this the app can reject an answer that is visibly, letter for
      // letter, the right one, and there is nothing on screen to explain it.
      // Keyboards mostly emit the composed form; paste does not always.
      .normalize("NFC")
      .replace(APOSTROPHES, "'")
      // French writes cœur and coeur both ways; only the ligature is optional,
      // never the accents.
      .replace(/œ/g, "oe")
      .replace(TERMINAL_PUNCTUATION, "")
      // Chunks are several words, so an extra space between them is a typo in
      // the typing, not in the French.
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function matches(typed: string, expected: string): boolean {
  return normalise(typed) === normalise(expected);
}

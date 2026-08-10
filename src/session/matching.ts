/**
 * Answer comparison. One rule decides everything here:
 * **orthography is graded, typography is not.**
 *
 * A missing accent changes the word — `fenetre` is not French. A ligature, the
 * apostrophe your keyboard happened to emit, or a space before a question mark
 * changes nothing about whether you know the word.
 */

/** `'` and friends. Phone and desktop keyboards disagree about which they emit. */
const APOSTROPHES = /[’ʼʹ´`]/g;

/** Stored and shown for TTS prosody (§7), never typed by the user. */
const TERMINAL_PUNCTUATION = /[?!.]+$/;

export function normalise(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
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

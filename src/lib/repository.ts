import { State } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";
import * as v from "valibot";
import type { Attempt, Card, Word } from "../session/types";
import { supabase } from "./supabase";

/** Rows as Postgres returns them: snake_case, dates as strings. */
export type WordRow = {
  id: string;
  text: string;
  gloss: string;
  hint: string | null;
  image: string | null;
  kind: "word" | "chunk";
  freq_rank: number | null;
};

/**
 * `due` is deliberately absent: it exists in the table only so the due query can
 * use an index, and `fsrs_state.due` is the value everything actually reads.
 * Selecting it would invite the two drifting apart in a reader's head.
 */
export type CardRow = {
  id: string;
  word_id: string;
  fsrs_state: unknown;
  created_at: string;
};

export function toWord(row: WordRow): Word {
  return {
    id: row.id,
    text: row.text,
    gloss: row.gloss,
    hint: row.hint,
    image: row.image,
    kind: row.kind,
    freqRank: row.freq_rank,
  };
}

/** A date as jsonb returns it: an ISO string, or a Date if it never left. */
const StoredDate = v.pipe(
  v.union([v.string(), v.date()]),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), "unparseable date"),
);

/**
 * What `cards.fsrs_state` is allowed to contain.
 *
 * Checked rather than cast. The cast that used to be here was the one place the
 * app took the database at its word, and the failure it allowed is silent: a
 * `due` that is a string rather than a Date makes ts-fsrs do arithmetic on a
 * string, which produces a schedule that is wrong without ever raising
 * anything — the worst kind of bug in a system whose whole job is deciding when
 * you next see a word. The same argument that justified reviving the dates
 * justifies checking that they arrived.
 *
 * `learning_steps` carries a default because ts-fsrs added it after some rows
 * were written; step 0 is where a card without one belongs.
 *
 * Loose on purpose: this shape belongs to ts-fsrs, not to us, and a plain
 * `v.object` strips the keys it does not know — so the next field upstream
 * adds would be silently deleted on every load, which is precisely the silent
 * mis-scheduling this validator exists to prevent. Known fields are checked;
 * unknown ones pass through untouched.
 */
const FsrsState = v.looseObject({
  due: StoredDate,
  stability: v.number(),
  difficulty: v.number(),
  elapsed_days: v.number(),
  scheduled_days: v.number(),
  learning_steps: v.optional(v.number(), 0),
  reps: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lapses: v.pipe(v.number(), v.integer(), v.minValue(0)),
  state: v.picklist([State.New, State.Learning, State.Review, State.Relearning]),
  last_review: v.optional(StoredDate),
});

/**
 * Rebuild the Date objects JSON threw away, refusing anything else.
 *
 * Loud rather than lenient: a card is a derived cache and can be rebuilt from
 * `attempts`, so unreadable scheduling state is a repairable problem — but only
 * if someone is told about it. Skipping the row instead would make the word look
 * uncarded, and re-introducing it would collide with the card already there.
 */
export function reviveFsrsCard(raw: unknown, cardId?: string): FsrsCard {
  const result = v.safeParse(FsrsState, raw);
  if (!result.success) {
    const where = cardId ? ` for card ${cardId}` : "";
    throw new Error(`Unreadable scheduling state${where}: ${v.summarize(result.issues)}`);
  }
  return result.output;
}

export function toCard(row: CardRow, guessed = false): Card {
  return {
    id: row.id,
    wordId: row.word_id,
    fsrs: reviveFsrsCard(row.fsrs_state, row.id),
    guessed,
  };
}

function startOfToday(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

export type Deck = {
  words: Word[];
  cards: Card[];
  introducedToday: number;
};

/**
 * Everything `loadDeck` does except the three queries.
 *
 * Split out because it is the part with decisions in it — which cards count as
 * guessed, what "today" means — and because a function that reaches for the
 * Supabase singleton cannot be tested. The session harness rebuilds its deck
 * through this exact function, so a test that resumes a sitting resumes it the
 * way the app does rather than the way a fixture author imagined.
 */
export function buildDeck(
  wordRows: readonly WordRow[],
  cardRows: readonly CardRow[],
  guessedCardIds: readonly string[],
  now: Date,
): Deck {
  const guessed = new Set(guessedCardIds);
  const midnight = startOfToday(now).getTime();

  return {
    words: wordRows.map(toWord),
    cards: cardRows.map((r) => toCard(r, guessed.has(r.id))),
    // Counted from the cards themselves rather than tracked separately, so
    // reopening the app mid-day resumes the allowance instead of restarting it.
    introducedToday: cardRows.filter((r) => new Date(r.created_at).getTime() >= midnight).length,
  };
}

export async function loadDeck(lang: string, now: Date): Promise<Deck> {
  const [words, cards, guesses] = await Promise.all([
    supabase
      .from("words")
      .select("id, text, gloss, hint, image, kind, freq_rank")
      .eq("lang", lang)
      .order("freq_rank", { ascending: true, nullsFirst: false }),
    // Cards are filtered by language through the word they point at. Without
    // this every other language's cards load too: none of them match a word in
    // the catalogue, and `introducedToday` counts them anyway — so a day spent
    // on French would silently eat the Spanish allowance.
    supabase
      .from("cards")
      .select("id, word_id, fsrs_state, created_at, words!inner(lang)")
      .eq("card_type", "production")
      .eq("words.lang", lang),
    // Which cards have ever been guessed. FSRS state cannot answer this —
    // guesses are never rated — and attempts is the source of truth, so ask it
    // rather than infer.
    supabase.from("attempts").select("card_id").eq("phase", "guess"),
  ]);

  if (words.error) throw new Error(`Could not load words: ${words.error.message}`);
  if (cards.error) throw new Error(`Could not load cards: ${cards.error.message}`);
  if (guesses.error) throw new Error(`Could not load attempts: ${guesses.error.message}`);

  return buildDeck(
    (words.data ?? []) as WordRow[],
    (cards.data ?? []) as unknown as CardRow[],
    (guesses.data ?? []).map((g) => g.card_id as string),
    now,
  );
}

/**
 * The same word was introduced somewhere else — another tab, or a phone that
 * was open at the same time.
 *
 * `unique(user_id, word_id, card_type)` is doing its job here: the row already
 * exists under a different id, so this write is a duplicate rather than an
 * update. Nothing is corrupted, but this session is holding an id the database
 * does not have, so every attempt it goes on to write would fail its foreign
 * key. Reloading adopts the row that won, which is the only way back.
 */
export class CardAlreadyExistsError extends Error {
  constructor(wordId: string) {
    super(`A card for word ${wordId} already exists on another device`);
    this.name = "CardAlreadyExistsError";
  }
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

export async function upsertCard(card: Card, userId: string): Promise<void> {
  const { error } = await supabase.from("cards").upsert(
    {
      id: card.id,
      user_id: userId,
      word_id: card.wordId,
      card_type: "production",
      fsrs_state: card.fsrs,
      due: card.fsrs.due.toISOString(),
    },
    { onConflict: "id" },
  );
  if (!error) return;
  // Conflicting on `id` is an update; conflicting on the word is a different
  // card for the same word, which is a different problem with a different cure.
  if (error.code === UNIQUE_VIOLATION) throw new CardAlreadyExistsError(card.wordId);
  throw new Error(`Could not save card: ${error.message}`);
}

export async function insertAttempt(attempt: Attempt, userId: string): Promise<void> {
  const { error } = await supabase.from("attempts").insert({
    user_id: userId,
    card_id: attempt.cardId,
    phase: attempt.phase,
    typed: attempt.typed,
    correct: attempt.correct,
    rating: attempt.rating,
    latency_ms: attempt.latencyMs,
    state_before: attempt.stateBefore,
    reviewed_at: attempt.reviewedAt.toISOString(),
  });
  if (error) throw new Error(`Could not save attempt: ${error.message}`);
}

/**
 * Writes run in the background, one after another.
 *
 * Not awaited, because answering a card must never wait on the network — that
 * latency is the thing the whole session design exists to avoid. Strictly
 * ordered, because a card insert has to land before the attempt that references
 * it. Failures are reported rather than swallowed: `attempts` is the source of
 * truth, so a lost write is a lost piece of history.
 *
 * The error itself is handed over rather than its message, because one of them —
 * `CardAlreadyExistsError` — is not something to show the user but something to
 * act on.
 */
export function createWriteQueue(onError: (error: Error) => void) {
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;

  return {
    push(task: () => Promise<void>): void {
      inFlight += 1;
      chain = chain
        .then(task)
        .catch((e: unknown) => onError(e instanceof Error ? e : new Error(String(e))))
        .then(() => {
          inFlight -= 1;
        });
    },
    get pending(): number {
      return inFlight;
    },
    settled(): Promise<void> {
      return chain;
    },
  };
}

import type { Card as FsrsCard } from "ts-fsrs";
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

/**
 * Rebuild the Date objects JSON threw away.
 *
 * `fsrs_state` is jsonb, so `due` and `last_review` come back as ISO strings.
 * ts-fsrs does arithmetic on them, and arithmetic on a string produces a
 * schedule that is wrong without ever raising an error — the worst kind of bug
 * in a system whose whole job is deciding when you next see a word.
 */
export function reviveFsrsCard(raw: unknown): FsrsCard {
  const state = raw as FsrsCard & { due: string | Date; last_review?: string | Date };
  return {
    ...state,
    due: new Date(state.due),
    last_review: state.last_review ? new Date(state.last_review) : undefined,
  };
}

export function toCard(row: CardRow, guessed = false): Card {
  return {
    id: row.id,
    wordId: row.word_id,
    fsrs: reviveFsrsCard(row.fsrs_state),
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
    supabase
      .from("cards")
      .select("id, word_id, fsrs_state, created_at")
      .eq("card_type", "production"),
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
    (cards.data ?? []) as CardRow[],
    (guesses.data ?? []).map((g) => g.card_id as string),
    now,
  );
}

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
  if (error) throw new Error(`Could not save card: ${error.message}`);
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
 */
export function createWriteQueue(onError: (message: string) => void) {
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;

  return {
    push(task: () => Promise<void>): void {
      inFlight += 1;
      chain = chain
        .then(task)
        .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
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

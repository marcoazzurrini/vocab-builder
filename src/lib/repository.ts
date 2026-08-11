import { createEmptyCard, State } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";
import * as v from "valibot";
import type { Attempt, Card, Word } from "../session/types";
import { dayStart } from "./day";
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
 * A `cards` row: nothing but the subject and the scheduling state. The row is
 * identified by `(user_id, word_id, card_type)` — the user is implied by RLS
 * and the type is filtered in the query, so what arrives is this.
 */
export type CardRow = {
  word_id: string;
  fsrs_state: unknown;
};

/** A guess attempt as the deck queries return it: which word, and when. */
export type GuessRow = {
  word_id: string;
  reviewed_at: string;
};

/** A recall attempt, one row per answer. Feeds the parking counters. */
export type RecallRow = {
  word_id: string;
  reviewed_at: string;
  correct: boolean;
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

export function toCard(row: CardRow): Card {
  return {
    wordId: row.word_id,
    fsrs: reviveFsrsCard(row.fsrs_state, row.word_id),
  };
}

export type Deck = {
  words: Word[];
  cards: Card[];
  introducedToday: number;
  /** Wrong recalls per word since the day rolled over. Feeds the parking counter. */
  failedToday: Map<string, number>;
  /** All recalls per word since the day rolled over, for the Hard-loop bound. */
  recalledToday: Map<string, number>;
};

export type Settings = {
  lang: string;
  newPerDay: number;
  dayRolloverHour: number;
};

/** Mirrors the column defaults, for a user who has never written a row. */
export const DEFAULT_SETTINGS: Settings = { lang: "fr", newPerDay: 15, dayRolloverHour: 4 };

export async function loadSettings(): Promise<Settings> {
  const { data, error } = await supabase
    .from("settings")
    .select("lang, new_per_day, day_rollover_hour")
    .maybeSingle();
  if (error) throw new Error(`Could not load settings: ${error.message}`);
  if (!data) return DEFAULT_SETTINGS;
  return {
    lang: data.lang as string,
    newPerDay: data.new_per_day as number,
    dayRolloverHour: data.day_rollover_hour as number,
  };
}

/**
 * Everything `loadDeck` does except the queries.
 *
 * Split out because it is the part with decisions in it — which guesses are
 * awaiting cards, what "today" means — and because a function that reaches for
 * the Supabase singleton cannot be tested. The session harness rebuilds its
 * deck through this exact function, so a test that resumes a sitting resumes
 * it the way the app does rather than the way a fixture author imagined.
 *
 * `guessRows` may arrive with overlap — the awaiting query and the today query
 * can both return the same guess — and the schema guarantees one guess per
 * word, so deduplicating by word is exact rather than lossy.
 */
export function buildDeck(
  wordRows: readonly WordRow[],
  cardRows: readonly CardRow[],
  guessRows: readonly GuessRow[],
  recallRows: readonly RecallRow[],
  now: Date,
  dayRolloverHour = 0,
): Deck {
  const midnight = dayStart(now, dayRolloverHour).getTime();
  const carded = new Set(cardRows.map((r) => r.word_id));
  const guesses = new Map(guessRows.map((g) => [g.word_id, g]));

  // One entry per recall since the day rolled over. Counted here rather than
  // in the session, so reopening the app mid-day resumes the parking counters
  // instead of resetting them — the same reasoning as the allowance.
  const failedToday = new Map<string, number>();
  const recalledToday = new Map<string, number>();
  for (const r of recallRows) {
    if (new Date(r.reviewed_at).getTime() < midnight) continue;
    recalledToday.set(r.word_id, (recalledToday.get(r.word_id) ?? 0) + 1);
    if (!r.correct) failedToday.set(r.word_id, (failedToday.get(r.word_id) ?? 0) + 1);
  }

  return {
    words: wordRows.map(toWord),
    cards: [
      ...cardRows.map(toCard),
      // A guess with no card row is a word waiting for its first rating: the
      // "awaiting" stage, rebuilt from the attempt that defines it. Seeded at
      // the guess time so the exposure rule shows them in introduction order.
      ...[...guesses.values()]
        .filter((g) => !carded.has(g.word_id))
        .map((g) => ({ wordId: g.word_id, fsrs: createEmptyCard(new Date(g.reviewed_at)) })),
    ],
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it. Guesses
    // are append-only, so not even deleting cards can refund a spent slot.
    introducedToday: [...guesses.values()].filter(
      (g) => new Date(g.reviewed_at).getTime() >= midnight,
    ).length,
    failedToday,
    recalledToday,
  };
}

export async function loadDeck(lang: string, now: Date, dayRolloverHour = 0): Promise<Deck> {
  const [words, cards, awaiting, today] = await Promise.all([
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
      .select("word_id, fsrs_state, words!inner(lang)")
      .eq("card_type", "production")
      .eq("words.lang", lang),
    // Guesses with no card row: words introduced but never rated. A view,
    // because "no matching card" is an anti-join PostgREST cannot express —
    // and it is the whole awaiting stage, so it must not be approximated.
    supabase
      .from("awaiting_guesses")
      .select("word_id, reviewed_at")
      .eq("card_type", "production")
      .eq("lang", lang),
    // Everything answered since the day rolled over, in one query: the
    // guesses say what the allowance has spent, the recalls feed the parking
    // counters.
    supabase
      .from("attempts")
      .select("word_id, phase, correct, reviewed_at, words!inner(lang)")
      .eq("card_type", "production")
      .eq("words.lang", lang)
      .gte("reviewed_at", dayStart(now, dayRolloverHour).toISOString()),
  ]);

  if (words.error) throw new Error(`Could not load words: ${words.error.message}`);
  if (cards.error) throw new Error(`Could not load cards: ${cards.error.message}`);
  if (awaiting.error) throw new Error(`Could not load awaiting words: ${awaiting.error.message}`);
  if (today.error) throw new Error(`Could not load today's attempts: ${today.error.message}`);

  type TodayRow = { word_id: string; phase: string; correct: boolean; reviewed_at: string };
  const todayRows = (today.data ?? []) as unknown as TodayRow[];

  return buildDeck(
    (words.data ?? []) as WordRow[],
    (cards.data ?? []) as unknown as CardRow[],
    [
      ...((awaiting.data ?? []) as unknown as GuessRow[]),
      ...todayRows.filter((r) => r.phase === "guess"),
    ],
    todayRows.filter((r) => r.phase === "recall"),
    now,
    dayRolloverHour,
  );
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The card is written under its natural key, so there is no id to disagree
 * about: two devices introducing the same word write the same row, and the
 * later write is an ordinary update. That was the whole collision — the old
 * surrogate id let each device mint its own name for the same card.
 */
export async function upsertCard(card: Card, userId: string): Promise<void> {
  const { error } = await supabase.from("cards").upsert(
    {
      user_id: userId,
      word_id: card.wordId,
      card_type: "production",
      fsrs_state: card.fsrs,
    },
    { onConflict: "user_id,word_id,card_type" },
  );
  if (error) throw new Error(`Could not save card: ${error.message}`);
}

export async function insertAttempt(attempt: Attempt, userId: string): Promise<void> {
  const { error } = await supabase.from("attempts").insert({
    user_id: userId,
    word_id: attempt.wordId,
    card_type: "production",
    phase: attempt.phase,
    typed: attempt.typed,
    correct: attempt.correct,
    rating: attempt.rating,
    latency_ms: attempt.latencyMs,
    state_before: attempt.stateBefore,
    reviewed_at: attempt.reviewedAt.toISOString(),
  });
  if (!error) return;
  // One guess per word, enforced by a partial unique index — so a duplicate
  // guess means another device introduced this word first and its pretest is
  // already on record. Nothing is lost and nothing needs doing.
  if (error.code === UNIQUE_VIOLATION && attempt.phase === "guess") return;
  throw new Error(`Could not save attempt: ${error.message}`);
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

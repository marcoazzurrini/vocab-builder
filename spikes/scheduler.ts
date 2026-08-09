// Scheduler spike — does the single-scheduler design survive contact?
//
// The README claims FSRS can own the whole card lifecycle via learning_steps +
// enable_short_term, with a minimum-interleave floor replacing the PoC's
// hardcoded [3,6,12] gap ladder. That was reasoning, not evidence. This prints
// the actual numbers.
//
//   node --experimental-strip-types spikes/scheduler.ts
//
// Fuzz is off throughout: it randomises intervals by design, which is right in
// production and useless when you are trying to read the shape of a schedule.

import { createEmptyCard, fsrs, Rating, State } from "ts-fsrs";
import type { Card, Grade } from "ts-fsrs";

const START = new Date("2026-08-10T09:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A card scheduled beyond this leaves today's session.
const SESSION_HORIZON = 12 * HOUR;
// Seconds of thinking + typing per answer. Override from the command line:
//   node --experimental-strip-types spikes/scheduler.ts 18
const ANSWER_SECONDS = Number(process.argv[2] ?? 18);

const f = fsrs({
  learning_steps: ["1m", "10m"],
  relearning_steps: ["10m"],
  enable_short_term: true,
  enable_fuzz: false,
});

const RATINGS: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];
const ratingName = (r: Grade) => Rating[r];
const stateName = (s: State) => State[s];

function gap(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  if (ms < HOUR) return `${(ms / MINUTE).toFixed(1)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

function rule(title: string) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

// ── 1. What does a brand-new card do on each of the four grades? ────────────
rule("1. New card, one rep, each grade");
console.log("grade   next due   state       stability  difficulty");
for (const r of RATINGS) {
  const { card } = f.next(createEmptyCard(START), START, r);
  console.log(
    `${ratingName(r).padEnd(7)} ${gap(START, card.due).padEnd(10)} ` +
      `${stateName(card.state).padEnd(11)} ${card.stability.toFixed(2).padStart(9)} ` +
      `${card.difficulty.toFixed(2).padStart(10)}`,
  );
}

// ── 2. The ideal path: a card answered Good every time ──────────────────────
rule("2. Always Good — how many reps to leave the session?");
console.log("rep  answered at   next due    gap       state       stability");
{
  let card: Card = createEmptyCard(START);
  let now = START;
  for (let rep = 1; rep <= 8; rep++) {
    const next = f.next(card, now, Rating.Good).card;
    console.log(
      `${String(rep).padStart(3)}  ${gap(START, now).padEnd(12)} ` +
        `${gap(START, next.due).padEnd(11)} ${gap(now, next.due).padEnd(9)} ` +
        `${stateName(next.state).padEnd(11)} ${next.stability.toFixed(2).padStart(9)}`,
    );
    if (next.due.getTime() - START.getTime() > SESSION_HORIZON) {
      console.log(`\n  → leaves the session after ${rep} rep(s)`);
      break;
    }
    card = next;
    now = next.due;
  }
}

// ── 3. A lapse on a mature card ─────────────────────────────────────────────
rule("3. Lapse — a graduated card answered Again");
{
  let card: Card = createEmptyCard(START);
  let now = START;
  for (let i = 0; i < 4; i++) {
    card = f.next(card, now, Rating.Good).card;
    now = card.due;
  }
  console.log(
    `mature card: due in ${gap(START, card.due)}, ` +
      `state ${stateName(card.state)}, stability ${card.stability.toFixed(2)}`,
  );
  const lapsed = f.next(card, now, Rating.Again).card;
  console.log(
    `after Again: next in ${gap(now, lapsed.due)}, ` +
      `state ${stateName(lapsed.state)}, stability ${lapsed.stability.toFixed(2)}, ` +
      `lapses ${lapsed.lapses}`,
  );
  const recovered = f.next(lapsed, lapsed.due, Rating.Good).card;
  console.log(
    `then Good:   next in ${gap(lapsed.due, recovered.due)}, ` +
      `state ${stateName(recovered.state)}`,
  );
}

// ── 4. A whole session ──────────────────────────────────────────────────────
// The real question. New cards all due at once, a queue that repeatedly picks
// the earliest-due card, and a floor that refuses to re-show a card until K
// others have gone by. Measures whether the floor is doing anything, whether
// idle waiting appears, and whether the thing terminates.

type SimCard = { id: number; card: Card; lastShownAt: number };

type SimOpts = {
  newCards: number;
  floor: number;
  ratingFor: (rep: number, id: number) => Grade;
  // Anki's "learn ahead" idea: when nothing is due yet, pull the next card
  // forward rather than sitting idle. 0 disables it.
  learnAheadMs?: number;
  // Cards already in Review and due today — the backlog a mature collection
  // has and a day-one collection does not.
  reviewCards?: number;
};

// A card that has been through a few successful reps and has come due again.
//
// Matured backwards from START so the review history sits in the past. Building
// it forwards and then forcing `due = START` leaves last_review in the future,
// and FSRS rejects the negative elapsed time — which it should.
function maturedCard(id: number): Card {
  const origin = new Date(START.getTime() - 200 * DAY);
  let card = createEmptyCard(origin);
  let now = origin;
  for (let i = 0; i < 3 + (id % 2); i++) {
    card = f.next(card, now, Rating.Good).card;
    now = card.due;
  }
  const lastReview = new Date(START.getTime() - (3 + (id % 5)) * DAY);
  return { ...card, due: START, last_review: lastReview };
}

function simulateWith(
  sched: ReturnType<typeof fsrs>,
  { newCards, floor, ratingFor, learnAheadMs = 0, reviewCards = 0 }: SimOpts,
) {
  const cards: SimCard[] = [
    ...Array.from({ length: newCards }, (_, id) => ({
      id,
      card: createEmptyCard(START),
      lastShownAt: -Infinity,
    })),
    ...Array.from({ length: reviewCards }, (_, i) => ({
      id: newCards + i,
      card: maturedCard(i),
      lastShownAt: -Infinity,
    })),
  ];

  let now = START;
  let position = 0;
  let idleMs = 0;
  let floorBound = 0;
  let pulledForward = 0;
  const gapsBetweenRepeats: number[] = [];
  const repsPerCard = new Map<number, number>();

  while (true) {
    const live = cards.filter((c) => c.card.due.getTime() - START.getTime() <= SESSION_HORIZON);
    if (live.length === 0) break;

    // Respect the floor when there is anything else to show.
    const eligible = live.filter((c) => position - c.lastShownAt >= floor);
    const pool = eligible.length > 0 ? eligible : live;
    if (eligible.length === 0 && live.length > 1) floorBound++;

    const chosen = pool.reduce((a, b) => (a.card.due <= b.card.due ? a : b));

    // Nothing is ready yet. Either pull it forward (learn ahead) or sit idle.
    const waitMs = chosen.card.due.getTime() - now.getTime();
    if (waitMs > 0) {
      if (waitMs <= learnAheadMs) {
        pulledForward++;
      } else {
        idleMs += waitMs;
        now = chosen.card.due;
      }
    }

    if (chosen.lastShownAt !== -Infinity) {
      gapsBetweenRepeats.push(position - chosen.lastShownAt);
    }

    const reps = (repsPerCard.get(chosen.id) ?? 0) + 1;
    repsPerCard.set(chosen.id, reps);
    chosen.card = sched.next(chosen.card, now, ratingFor(reps, chosen.id)).card;
    chosen.lastShownAt = position;
    position++;
    now = new Date(now.getTime() + ANSWER_SECONDS * 1000);

    if (position > 5000) {
      console.log("  !! did not terminate — aborted at 5000 reps");
      break;
    }
  }

  const totals = [...repsPerCard.values()];
  const sorted = [...gapsBetweenRepeats].sort((a, b) => a - b);
  return {
    reps: position,
    wallClock: gap(START, now),
    idle: idleMs / MINUTE,
    floorBound,
    pulledForward,
    minGap: sorted[0] ?? 0,
    medGap: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maxGap: sorted[sorted.length - 1] ?? 0,
    repsPerCard: (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1),
  };
}

const simulate = (o: SimOpts) => simulateWith(f, o);

const perfect = () => Rating.Good;
// A plausible learner: first rep after exposure usually lands, and it gets
// easier from there. Deterministic so runs are comparable.
const realistic = (rep: number, id: number): Grade => {
  const stumble = (id * 7 + rep * 3) % 10;
  if (rep === 1) return stumble < 3 ? Rating.Again : Rating.Good;
  if (rep === 2) return stumble < 2 ? Rating.Again : Rating.Good;
  return stumble < 1 ? Rating.Again : stumble < 4 ? Rating.Hard : Rating.Good;
};

rule("4. Full session — 10 new cards");
console.log(
  "learner     floor  reps  wall-clock  idle(min)  floor-bound  gap min/med/max  reps/card",
);
for (const floor of [0, 2, 3]) {
  for (const [name, fn] of [
    ["perfect", perfect],
    ["realistic", realistic],
  ] as const) {
    const r = simulate({ newCards: 10, floor, ratingFor: fn });
    console.log(
      `${name.padEnd(11)} ${String(floor).padStart(5)} ${String(r.reps).padStart(5)} ` +
        `${r.wallClock.padStart(11)} ${r.idle.toFixed(1).padStart(10)} ` +
        `${String(r.floorBound).padStart(12)} ` +
        `${`${r.minGap}/${r.medGap}/${r.maxGap}`.padStart(16)} ${r.repsPerCard.padStart(10)}`,
    );
  }
}

// The case the PoC degenerated on: too few cards to space against.
rule("5. Thin queue — where the hardcoded ladder collapsed");
console.log("cards  floor  reps  wall-clock  idle(min)  gap min/med/max");
for (const n of [2, 3, 5]) {
  for (const floor of [0, 2]) {
    const r = simulate({ newCards: n, floor, ratingFor: perfect });
    console.log(
      `${String(n).padStart(5)} ${String(floor).padStart(6)} ${String(r.reps).padStart(5)} ` +
        `${r.wallClock.padStart(11)} ${r.idle.toFixed(1).padStart(10)} ` +
        `${`${r.minGap}/${r.medGap}/${r.maxGap}`.padStart(16)}`,
    );
  }
}

// ── 6. Learn-ahead window ───────────────────────────────────────────────────
// The idle time above is not a rounding error, so measure the standard fix:
// when nothing is due, show the next card early if it is close enough.
rule("6. Learn-ahead window — 10 new cards, no backlog");
console.log("window  reps  wall-clock  idle(min)  pulled forward");
for (const [label, ms] of [
  ["off", 0],
  ["1m", 1 * MINUTE],
  ["5m", 5 * MINUTE],
  ["20m", 20 * MINUTE],
] as const) {
  const r = simulate({ newCards: 10, floor: 0, ratingFor: realistic, learnAheadMs: ms });
  console.log(
    `${label.padEnd(7)} ${String(r.reps).padStart(5)} ${r.wallClock.padStart(11)} ` +
      `${r.idle.toFixed(1).padStart(10)} ${String(r.pulledForward).padStart(15)}`,
  );
}

// ── 7. Cold start vs a mature collection ────────────────────────────────────
// Anki users rarely feel the learning-step gap because due reviews fill it.
// Does a realistic backlog remove the idle time on its own?
rule("7. Does a review backlog absorb the gap? (no learn-ahead)");
console.log("new  due reviews  reps  wall-clock  idle(min)  idle %");
for (const [n, rev] of [
  [10, 0],
  [10, 10],
  [10, 30],
  [10, 60],
] as const) {
  const r = simulate({ newCards: n, floor: 0, ratingFor: realistic, reviewCards: rev });
  const totalMin = r.reps * (ANSWER_SECONDS / 60) + r.idle;
  console.log(
    `${String(n).padStart(3)} ${String(rev).padStart(12)} ${String(r.reps).padStart(5)} ` +
      `${r.wallClock.padStart(11)} ${r.idle.toFixed(1).padStart(10)} ` +
      `${((r.idle / totalMin) * 100).toFixed(0).padStart(6)}%`,
  );
}

// ── 8. Learning steps vs session size ───────────────────────────────────────
// Learn-ahead removes idle time by showing cards early — which quietly undoes
// the very spacing the step was there to create. The honest variable is the
// step itself: one pass of N cards takes N * ANSWER_SECONDS, so a step much
// longer than that guarantees dead air, and one much shorter is massing.
rule("8. Learning steps vs deck size (no learn-ahead)");
console.log(`one pass of 10 cards = ${(10 * ANSWER_SECONDS) / 60} min\n`);
console.log("steps            cards  reps  wall-clock  idle(min)  idle %  reps/card");
for (const steps of [
  ["1m", "3m"],
  ["1m", "5m"],
  ["1m", "10m"],
  ["2m", "10m", "30m"],
] as const) {
  for (const n of [10, 30] as const) {
    const scheduler = fsrs({
      learning_steps: [...steps],
      relearning_steps: ["10m"],
      enable_short_term: true,
      enable_fuzz: false,
    });
    const r = simulateWith(scheduler, { newCards: n, floor: 0, ratingFor: realistic });
    const totalMin = r.reps * (ANSWER_SECONDS / 60) + r.idle;
    console.log(
      `${steps.join(",").padEnd(16)} ${String(n).padStart(5)} ${String(r.reps).padStart(5)} ` +
        `${r.wallClock.padStart(11)} ${r.idle.toFixed(1).padStart(10)} ` +
        `${((r.idle / totalMin) * 100).toFixed(0).padStart(6)}% ${r.repsPerCard.padStart(10)}`,
    );
  }
}

// ── 9. Zero-idle policy ─────────────────────────────────────────────────────
// Waiting is never acceptable. When nothing is due, pull the soonest card
// forward. FSRS scores on actual elapsed time, so an early review is scored
// correctly -- it simply earns less stability than a longer gap would have.
//
// The question is what this does to the real gap between repeats, and whether
// the configured learning step still matters once the policy is in place.
rule("9. Zero-idle policy — always pull forward, never wait");
console.log("steps       cards  reps  wall-clock  idle  effective gap (cards) min/med/max");
for (const steps of [
  ["1m", "3m"],
  ["1m", "10m"],
] as const) {
  for (const n of [10, 30] as const) {
    const scheduler = fsrs({
      learning_steps: [...steps],
      relearning_steps: ["10m"],
      enable_short_term: true,
      enable_fuzz: false,
    });
    const r = simulateWith(scheduler, {
      newCards: n,
      floor: 0,
      ratingFor: realistic,
      learnAheadMs: Number.POSITIVE_INFINITY,
    });
    console.log(
      `${steps.join(",").padEnd(11)} ${String(n).padStart(5)} ${String(r.reps).padStart(5)} ` +
        `${r.wallClock.padStart(11)} ${`${r.idle.toFixed(1)}m`.padStart(5)} ` +
        `${`${r.minGap}/${r.medGap}/${r.maxGap}`.padStart(28)}`,
    );
  }
}

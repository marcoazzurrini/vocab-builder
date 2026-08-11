import { useEffect, useReducer, useRef, useState } from "react";
import { createWriteQueue, insertAttempt, loadDeck, upsertCard } from "./lib/repository";
import { speak, warmUpVoices } from "./lib/speak";
import { createSession } from "./session";
import type { Effort, Session } from "./session";

const LANG = "fr";
const NEW_PER_DAY = 15;

const EFFORT_LABEL: Record<Effort, string> = {
  hard: "Difficile",
  good: "Bene",
  easy: "Facile",
};

const startOfDay = (d: Date) => new Date(d).setHours(0, 0, 0, 0);

export function SessionScreen({ userId }: { userId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  /** Bumped to rebuild the session from storage. See the reload effect below. */
  const [reloadCount, reload] = useReducer((n: number) => n + 1, 0);

  // The session is a mutable object, not React state — calling a method changes
  // it in place, so the component asks for a re-render rather than replacing it.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Read by the reload effect, which must not re-subscribe on every answer. */
  const sessionRef = useRef<Session | null>(null);
  const loadedOnRef = useRef(startOfDay(new Date()));
  /**
   * One queue for the component's whole life, not one per load.
   *
   * A queue created inside the load effect dies with it — but its writes do
   * not, so a rebuild would race the previous session's unfinished writes and
   * read the database from before them. Shared, the queue can be waited on
   * across reloads: the rebuild reads its own writes.
   */
  const queueRef = useRef<ReturnType<typeof createWriteQueue> | null>(null);
  queueRef.current ??= createWriteQueue((error) => setWriteError(error.message));
  const queue = queueRef.current;

  useEffect(() => {
    warmUpVoices();
    let cancelled = false;

    // Writes run in the background, so a rebuild can race its own history:
    // answer the last card, see "Bravo", switch apps and back — and the deck
    // is re-read while the answer is still in flight, which serves the card
    // just answered again. Waiting for the queue first closes that gap.
    queue
      .settled()
      .then(() => {
        const now = new Date();
        loadedOnRef.current = startOfDay(now);
        return loadDeck(LANG, now);
      })
      .then((deck) => {
        if (cancelled) return;
        setWriteError(null);
        const created = createSession({
          words: deck.words,
          cards: deck.cards,
          newPerDay: NEW_PER_DAY,
          introducedToday: deck.introducedToday,
          onCardChange: (card) => queue.push(() => upsertCard(card, userId)),
          onAttempt: (attempt) => queue.push(() => insertAttempt(attempt, userId)),
        });
        sessionRef.current = created;
        setSession(created);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [userId, reloadCount, queue]);

  /**
   * A tab closed with writes in flight loses them, and `attempts` is the one
   * table that cannot be rebuilt. The browser shows its generic "leave site?"
   * dialog — not our words, but our timing.
   */
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (queue.pending > 0) event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);

  /**
   * Come back to a session that is still true.
   *
   * The deck is read once, and `done` is final — so a phone left on the end
   * screen overnight still shows yesterday's "Bravo" in the morning, with the
   * day's cards waiting behind it and nothing to say so. A session left open
   * across midnight is worse: the rule starts serving tomorrow's reviews while
   * the allowance is still yesterday's, because that number was read at load.
   *
   * Rebuilding is cheap and loses nothing — every answer is already written — so
   * the only question is when it is safe. Mid-card it is not: it would throw away
   * the prompt on screen. Between cards it always is.
   */
  useEffect(() => {
    function recheck() {
      if (document.visibilityState !== "visible") return;
      const newDay = startOfDay(new Date()) !== loadedOnRef.current;
      const between = sessionRef.current?.view.phase === "done";
      if (newDay || between) reload();
    }

    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, []);

  const view = session?.view;
  const phase = view?.phase;
  // Pulled out of the dependency arrays so they can be checked statically.
  // The gloss changes whenever the card does, which is what should re-run these.
  const exposureAnswer = view?.phase === "exposure" ? view.answer : null;
  const promptGloss = view && "prompt" in view ? view.prompt.gloss : null;

  // One clean exposure: see it, hear it, say it (§2, §6).
  useEffect(() => {
    if (exposureAnswer) speak(exposureAnswer, setAudioError);
  }, [exposureAnswer]);

  useEffect(() => {
    if (phase === "guess" || phase === "recall") inputRef.current?.focus();
  }, [phase, promptGloss]);

  function act(fn: () => void) {
    fn();
    setTyped("");
    rerender();
  }

  if (loadError) return <p role="alert">Errore nel caricamento: {loadError}</p>;
  if (!view) return <p>Carico…</p>;

  return (
    <div className="card">
      {view.phase === "guess" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() => session!.submitGuess(typed));
          }}
        >
          <p className="eyebrow">parola nuova · prova a indovinare</p>
          <Prompt image={view.prompt.image} gloss={view.prompt.gloss} hint={view.prompt.hint} />
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="come si dice in francese?"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {/* Empty is a valid answer — a shrug is a legitimate pretest (§3). */}
          <button type="submit">Continua</button>
        </form>
      )}

      {view.phase === "exposure" && (
        <>
          <p className="eyebrow">ascolta e ripeti ad alta voce</p>
          <p className="answer">{view.answer}</p>
          <p className="gloss">{view.prompt.gloss}</p>
          <button type="button" className="ghost" onClick={() => speak(view.answer, setAudioError)}>
            Riascolta
          </button>
          <button type="button" onClick={() => act(() => session!.exposureDone())}>
            L'ho detta
          </button>
        </>
      )}

      {view.phase === "recall" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // Enter means Good: the default path is one action and asks for no
            // grading decision.
            act(() => session!.submitRecall(typed, "good"));
          }}
        >
          <p className="eyebrow">scrivi la parola francese</p>
          <Prompt image={view.prompt.image} gloss={view.prompt.gloss} hint={view.prompt.hint} />
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="efforts">
            {/* The list comes from the session. The UI does not know that Easy
                is withheld on a first recall, only that it was not offered. */}
            {view.efforts.map((effort) => (
              <button
                key={effort}
                type={effort === "good" ? "submit" : "button"}
                className={effort === "good" ? "" : "ghost"}
                onClick={
                  effort === "good"
                    ? undefined
                    : () => act(() => session!.submitRecall(typed, effort))
                }
              >
                {EFFORT_LABEL[effort]}
              </button>
            ))}
          </div>
        </form>
      )}

      {view.phase === "feedback" && (
        <>
          <p className="eyebrow wrong">non ancora</p>
          <p className="answer">{view.expected}</p>
          {/* No diff highlighting — finding the difference is the point (§2). */}
          <p className="typed">hai scritto: {view.typed || "—"}</p>
          <button type="button" onClick={() => act(() => session!.dismissFeedback())}>
            Continua
          </button>
        </>
      )}

      {view.phase === "done" && (
        <>
          <p className="eyebrow">sessione finita</p>
          <p className="answer">Bravo</p>
          <p className="gloss">
            {view.stats.introduced} parole nuove · {view.stats.correct}/{view.stats.recalls}{" "}
            richiami corretti
          </p>
        </>
      )}

      {audioError && <p className="note">{audioError}</p>}
      {writeError && (
        <p role="alert" className="note wrong">
          Salvataggio non riuscito: {writeError}
        </p>
      )}
    </div>
  );
}

function Prompt({
  image,
  gloss,
  hint,
}: {
  image: string | null;
  gloss: string;
  hint: string | null;
}) {
  return (
    <>
      {image && <p className="image">{image}</p>}
      <p className="gloss">{gloss}</p>
      {hint && <p className="hint">{hint}</p>}
    </>
  );
}

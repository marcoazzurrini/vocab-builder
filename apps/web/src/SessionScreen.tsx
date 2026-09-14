import { useEffect, useReducer, useRef, useState } from "react";
import { dayStart } from "@vocab/study/day";
import { loadDeck, loadSettings, persistAnswer } from "./lib/repository";
import { DEFAULT_SETTINGS } from "@vocab/study/deck";
import type { Settings } from "@vocab/study/deck";
import { commandFor, SyncConflict } from "@vocab/study/commands";
import { createOutbox } from "./lib/outbox";
import { speak, warmUpVoices } from "./lib/speak";
import { createSession } from "@vocab/study";
import type { Effort, Session } from "@vocab/study";

const EFFORT_LABEL: Record<Effort, string> = {
  hard: "Difficile",
  good: "Bene",
  easy: "Facile",
};

export function SessionScreen({ userId }: { userId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
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
  /** What the last load ran with. The recheck needs the rollover hour too. */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const loadedOnRef = useRef(dayStart(new Date(), DEFAULT_SETTINGS.dayRolloverHour).getTime());
  /**
   * One queue for the component's whole life, not one per load.
   *
   * A queue created inside the load effect dies with it — but its writes do
   * not, so a rebuild would race the previous session's unfinished writes and
   * read the database from before them. Shared, the queue can be waited on
   * across reloads: the rebuild reads its own writes.
   */
  const queueRef = useRef<ReturnType<typeof createOutbox> | null>(null);
  queueRef.current ??= createOutbox({
    userId,
    storage: window.localStorage,
    send: (command) => persistAnswer(command, userId),
    onError: (error) => {
      setWriteError(error.message);
      setSyncConflict(error instanceof SyncConflict);
    },
  });
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
      .then(() => loadSettings())
      .then((settings) => {
        settingsRef.current = settings;
        const now = new Date();
        loadedOnRef.current = dayStart(now, settings.dayRolloverHour).getTime();
        return Promise.all([
          loadDeck(settings.lang, now, settings.dayRolloverHour),
          Promise.resolve(settings),
        ]);
      })
      .then(([deck, settings]) => {
        if (cancelled) return;
        setWriteError(null);
        const created = createSession({
          words: deck.words,
          cards: deck.cards,
          newPerDay: settings.newPerDay,
          introducedToday: deck.introducedToday,
          dayRolloverHour: settings.dayRolloverHour,
          // The server records the attempt and derives its schedule in one transaction.
          onAttempt: (attempt) => queue.push(commandFor(attempt)),
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
   * Answers are retained locally until acknowledged. Still warn before leaving:
   * clearing browser storage before sync would lose the only copy.
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
      const rollover = settingsRef.current.dayRolloverHour;
      const newDay = dayStart(new Date(), rollover).getTime() !== loadedOnRef.current;
      const phaseNow = sessionRef.current?.view.phase;
      const between = phaseNow === "done" || phaseNow === "caughtUp";
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
  const nextDueMs = view?.phase === "caughtUp" ? view.nextDueAt.getTime() : null;

  /**
   * Caught up is a pause, not an end: rebuild when the next card comes due.
   * The extra second keeps the rebuilt queue from landing a hair before the
   * due time and showing the same screen again.
   */
  useEffect(() => {
    if (nextDueMs === null) return;
    const timer = setTimeout(reload, Math.max(1000, nextDueMs - Date.now() + 1000));
    return () => clearTimeout(timer);
  }, [nextDueMs]);

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

  if (loadError || writeError)
    return (
      <div>
        <p role="alert" className="note wrong">
          {writeError ? "Salvataggio non riuscito" : "Caricamento non riuscito"}:{" "}
          {writeError ?? loadError}
        </p>
        <p className="note">
          Riprova prima di continuare. Non cancellare i dati del browser: potrebbero contenere
          risposte da salvare.
        </p>
        <button
          type="button"
          onClick={() => {
            void queue
              .retry()
              .then(() => {
                setLoadError(null);
                setWriteError(null);
                reload();
              })
              .catch((error: unknown) =>
                setWriteError(error instanceof Error ? error.message : String(error)),
              );
          }}
        >
          Riprova
        </button>
        {syncConflict && (
          <button
            type="button"
            onClick={() => {
              if (
                !window.confirm(
                  "Scartare tutte le risposte non sincronizzate su questo dispositivo? Questa azione non può essere annullata. I progressi già salvati rimangono invariati.",
                )
              )
                return;
              try {
                queue.discard();
                setLoadError(null);
                setWriteError(null);
                setSyncConflict(false);
                reload();
              } catch (error) {
                setWriteError(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            Scarta risposte in attesa e ricarica
          </button>
        )}
      </div>
    );
  if (!view) return <p className="note">Carico…</p>;

  return (
    // Keyed so the entrance animation replays when the phase or card changes —
    // a remount is exactly the "new screen" the motion is meant to mark.
    <div className="stage" key={`${view.phase}:${promptGloss ?? ""}`}>
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
          <div className="actions">
            <button type="submit">Continua</button>
          </div>
        </form>
      )}

      {view.phase === "exposure" && (
        <>
          <p className="eyebrow">ascolta e ripeti ad alta voce</p>
          {view.prompt.image && <p className="image">{view.prompt.image}</p>}
          <p className="answer">{view.answer}</p>
          <p className="gloss">{view.prompt.gloss}</p>
          <div className="actions">
            <button
              type="button"
              className="audio"
              onClick={() => speak(view.answer, setAudioError)}
            >
              Riascolta
            </button>
            <button type="button" onClick={() => act(() => session!.exposureDone())}>
              L'ho detta
            </button>
          </div>
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
          <div className="actions">
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
          <p className="kbd-hint">
            <kbd>Invio</kbd> = Bene
          </p>
        </form>
      )}

      {view.phase === "feedback" && (
        <>
          <p className="eyebrow wrong">non ancora</p>
          <p className="answer">{view.expected}</p>
          {/* No diff highlighting — finding the difference is the point (§2). */}
          <p className="typed">
            hai scritto: <b>{view.typed || "—"}</b>
          </p>
          <div className="actions">
            <button type="button" onClick={() => act(() => session!.dismissFeedback())}>
              Continua
            </button>
          </div>
        </>
      )}

      {view.phase === "caughtUp" && (
        <>
          <p className="eyebrow">sei in pari</p>
          {/* Italian, so the sans voice — .answer is reserved for French. */}
          <p className="status">Tutto fatto, per ora</p>
          <p className="stats">
            {view.stats.introduced} parole nuove · {view.stats.correct}/{view.stats.recalls}{" "}
            richiami corretti
          </p>
          <p className="note">
            Prossima carta tra ~{Math.max(1, Math.ceil((nextDueMs! - Date.now()) / 60_000))} min —
            questa pagina riparte da sola.
          </p>
        </>
      )}

      {view.phase === "done" && (
        <>
          <p className="eyebrow">sessione finita</p>
          <p className="status">Bravo</p>
          <p className="stats">
            {view.stats.introduced} parole nuove · {view.stats.correct}/{view.stats.recalls}{" "}
            richiami corretti
          </p>
        </>
      )}

      {audioError && <p className="note">{audioError}</p>}
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

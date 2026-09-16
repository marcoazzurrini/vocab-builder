import type { Effort } from "@vocab/spaced-repetition";
import { useEffect, useRef, useState } from "react";

import { speak, warmUpVoices } from "./speak";
import type { PracticeTransport } from "./transport";
import { usePracticeSession } from "./use-practice-session";

const EFFORT_LABEL: Record<Effort, string> = {
  easy: "Facile",
  good: "Bene",
  hard: "Difficile",
};

const Prompt = ({
  image,
  gloss,
  hint,
}: {
  image: string | null;
  gloss: string;
  hint: string | null;
}) => (
  <>
    {image && <p className="image">{image}</p>}
    <p className="gloss">{gloss}</p>
    {hint && <p className="hint">{hint}</p>}
  </>
);

const NextDueNote = ({ due }: { due: number }) => {
  // eslint-disable-next-line react/hook-use-state -- Capture time when this due notice mounts; its keyed remount refreshes the estimate without impure renders.
  const [now] = useState(Date.now);
  return (
    <p className="note">
      Prossima carta tra ~{Math.max(1, Math.ceil((due - now) / 60_000))} min —
      questa pagina riparte da sola.
    </p>
  );
};

const Recovery = ({
  practice,
}: {
  practice: ReturnType<typeof usePracticeSession>;
}) => (
  <div>
    <p role="alert" className="note wrong">
      {practice.writeError
        ? "Salvataggio non riuscito"
        : "Caricamento non riuscito"}
      : {practice.writeError ?? practice.loadError}
    </p>
    <p className="note">
      Riprova prima di continuare. Non cancellare i dati del browser: potrebbero
      contenere risposte da salvare.
    </p>
    <button
      type="button"
      disabled={practice.recovering}
      onClick={() => {
        void practice.retry();
      }}
    >
      Riprova
    </button>
    {practice.syncConflict && (
      <button
        type="button"
        disabled={practice.recovering}
        onClick={() => {
          // eslint-disable-next-line no-alert -- Discarding the only durable copy requires explicit user confirmation.
          const confirmed = window.confirm(
            "Scartare tutte le risposte non sincronizzate su questo dispositivo? Questa azione non può essere annullata. I progressi già salvati rimangono invariati."
          );
          if (confirmed) {
            practice.discard();
          }
        }}
      >
        Scarta risposte in attesa e ricarica
      </button>
    )}
  </div>
);

export const SessionScreen = ({
  userId,
  transport,
}: {
  userId: string;
  transport?: PracticeTransport;
}) => {
  const practice = usePracticeSession(userId, transport);
  const { view, loadError, writeError } = practice;
  const [audioError, setAudioError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const phase = view?.phase;

  useEffect(() => {
    warmUpVoices();
  }, []);

  // Pulled out of the dependency arrays so they can be checked statically.
  // The gloss changes whenever the card does, which is what should re-run these.
  const exposureAnswer = view?.phase === "exposure" ? view.answer : null;
  const promptGloss = view && "prompt" in view ? view.prompt.gloss : null;

  // One clean exposure: see it, hear it, say it (§2, §6).
  useEffect(() => {
    if (exposureAnswer) {
      speak(exposureAnswer, setAudioError);
    }
  }, [exposureAnswer]);

  useEffect(() => {
    if (phase === "guess" || phase === "recall") {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- A new card must refocus the remounted input even when its phase is unchanged.
  }, [phase, promptGloss]);

  const act = (fn: () => void) => {
    fn();
    setTyped("");
  };

  if (loadError || writeError) {
    return <Recovery practice={practice} />;
  }
  if (!view) {
    return <p className="note">Carico…</p>;
  }

  return (
    // Keyed so the entrance animation replays when the phase or card changes —
    // a remount is exactly the "new screen" the motion is meant to mark.
    <div className="stage" key={`${view.phase}:${promptGloss ?? ""}`}>
      {view.phase === "guess" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() => practice.submitGuess(typed));
          }}
        >
          <p className="eyebrow">parola nuova · prova a indovinare</p>
          <Prompt
            image={view.prompt.image}
            gloss={view.prompt.gloss}
            hint={view.prompt.hint}
          />
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
            <button
              type="button"
              onClick={() => act(() => practice.exposureDone())}
            >
              L&apos;ho detta
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
            act(() => practice.submitRecall(typed, "good"));
          }}
        >
          <p className="eyebrow">scrivi la parola francese</p>
          <Prompt
            image={view.prompt.image}
            gloss={view.prompt.gloss}
            hint={view.prompt.hint}
          />
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
                    : () => act(() => practice.submitRecall(typed, effort))
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
            <button
              type="button"
              onClick={() => act(() => practice.dismissFeedback())}
            >
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
            {view.stats.introduced} parole nuove · {view.stats.correct}/
            {view.stats.recalls} richiami corretti
          </p>
          <NextDueNote
            key={view.nextDueAt.getTime()}
            due={view.nextDueAt.getTime()}
          />
        </>
      )}

      {view.phase === "done" && (
        <>
          <p className="eyebrow">sessione finita</p>
          <p className="status">Bravo</p>
          <p className="stats">
            {view.stats.introduced} parole nuove · {view.stats.correct}/
            {view.stats.recalls} richiami corretti
          </p>
        </>
      )}

      {audioError && <p className="note">{audioError}</p>}
    </div>
  );
};

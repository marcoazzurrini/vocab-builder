import { Trans, Plural, useLingui } from "@lingui/react/macro";
import type { Effort } from "@vocab/spaced-repetition";
import { useEffect, useRef, useState } from "react";

import { speak, warmUpVoices } from "./speak";
import type { SpeechFailure } from "./speak";
import type { PracticeTransport } from "./transport";
import { usePracticeSession } from "./use-practice-session";

const SessionStats = ({
  introduced,
  correct,
  recalls,
}: {
  introduced: number;
  correct: number;
  recalls: number;
}) => (
  <p className="stats">
    <Plural value={introduced} one="# new word" other="# new words" />
    {" · "}
    <Trans>
      {correct}/{recalls} correct answers
    </Trans>
  </p>
);

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
  const minutes = Math.max(1, Math.ceil((due - now) / 60_000));
  return (
    <p className="note">
      <Trans>
        Next word in about {minutes} min. Your session will resume
        automatically.
      </Trans>
    </p>
  );
};

const Recovery = ({
  practice,
}: {
  practice: ReturnType<typeof usePracticeSession>;
}) => {
  const { t } = useLingui();
  return (
    <div>
      <p role="alert" className="note wrong">
        {practice.writeError
          ? t`Could not save your answers`
          : t`Could not load your session`}
        : {practice.writeError ?? practice.loadError}
      </p>
      <p className="note">
        <Trans>
          Try again before continuing. Do not clear your browser data: it may
          contain answers that have not been saved yet.
        </Trans>
      </p>
      <button
        type="button"
        disabled={practice.recovering}
        onClick={() => {
          void practice.retry();
        }}
      >
        <Trans>Try again</Trans>
      </button>
      {practice.syncConflict && (
        <button
          type="button"
          disabled={practice.recovering}
          onClick={() => {
            // eslint-disable-next-line no-alert -- Discarding the only durable copy requires explicit user confirmation.
            const confirmed = window.confirm(
              t`Delete all unsynced answers on this device? This cannot be undone. Progress already saved will not change.`
            );
            if (confirmed) {
              practice.discard();
            }
          }}
        >
          <Trans>Delete unsynced answers and reload</Trans>
        </button>
      )}
    </div>
  );
};

export const SessionScreen = ({
  userId,
  transport,
}: {
  userId: string;
  transport?: PracticeTransport;
}) => {
  const { t } = useLingui();
  const effortLabel: Record<Effort, string> = {
    easy: t`Easy`,
    good: t`Good`,
    hard: t`Hard`,
  };
  const practice = usePracticeSession(userId, transport);
  const { view, loadError, writeError } = practice;
  const [audioError, setAudioError] = useState<SpeechFailure | null>(null);
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
    return (
      <p className="note">
        <Trans>Loading…</Trans>
      </p>
    );
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
          <p className="eyebrow">
            <Trans>new word · take a guess</Trans>
          </p>
          <Prompt
            image={view.prompt.image}
            gloss={view.prompt.gloss}
            hint={view.prompt.hint}
          />
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t`how do you say it in French?`}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {/* Empty is a valid answer — a shrug is a legitimate pretest (§3). */}
          <div className="actions">
            <button type="submit">
              <Trans>Continue</Trans>
            </button>
          </div>
        </form>
      )}

      {view.phase === "exposure" && (
        <>
          <p className="eyebrow">
            <Trans>listen and repeat aloud</Trans>
          </p>
          {view.prompt.image && <p className="image">{view.prompt.image}</p>}
          <p className="answer">{view.answer}</p>
          <p className="gloss">{view.prompt.gloss}</p>
          <div className="actions">
            <button
              type="button"
              className="audio"
              onClick={() => speak(view.answer, setAudioError)}
            >
              <Trans>Listen again</Trans>
            </button>
            <button
              type="button"
              onClick={() => act(() => practice.exposureDone())}
            >
              <Trans>I&apos;ve said it aloud</Trans>
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
          <p className="eyebrow">
            <Trans>type the French word</Trans>
          </p>
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
                {effortLabel[effort]}
              </button>
            ))}
          </div>
          <p className="kbd-hint">
            <Trans>
              <kbd>Enter</kbd> = Good
            </Trans>
          </p>
        </form>
      )}

      {view.phase === "feedback" && (
        <>
          <p className="eyebrow wrong">
            <Trans>not quite</Trans>
          </p>
          <p className="answer">{view.expected}</p>
          {/* No diff highlighting — finding the difference is the point (§2). */}
          <p className="typed">
            <Trans>
              you wrote: <b>{view.typed || "—"}</b>
            </Trans>
          </p>
          <div className="actions">
            <button
              type="button"
              onClick={() => act(() => practice.dismissFeedback())}
            >
              <Trans>Continue</Trans>
            </button>
          </div>
        </>
      )}

      {view.phase === "caughtUp" && (
        <>
          <p className="eyebrow">
            <Trans>you&apos;re all caught up</Trans>
          </p>
          {/* Interface text uses the sans voice; .answer is reserved for French. */}
          <p className="status">
            <Trans>All done, for now</Trans>
          </p>
          <SessionStats {...view.stats} />
          <NextDueNote
            key={view.nextDueAt.getTime()}
            due={view.nextDueAt.getTime()}
          />
        </>
      )}

      {view.phase === "done" && (
        <>
          <p className="eyebrow">
            <Trans>session complete</Trans>
          </p>
          <p className="status">
            <Trans>Well done</Trans>
          </p>
          <SessionStats {...view.stats} />
        </>
      )}

      {audioError && (
        <p className="note">
          {audioError.kind === "unsupported"
            ? t`This browser does not support reading words aloud.`
            : t`Could not play the audio (${audioError.reason}).`}
        </p>
      )}
    </div>
  );
};

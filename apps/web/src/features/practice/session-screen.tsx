import { Trans, Plural, useLingui } from "@lingui/react/macro";
import type { Effort } from "@vocab/spaced-repetition";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";

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
  <p className="text-muted-foreground text-sm tabular-nums">
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
  <div className="flex flex-col gap-3">
    {image && <p className="text-5xl">{image}</p>}
    <p className="text-xl text-pretty">{gloss}</p>
    {hint && (
      <p className="text-muted-foreground text-sm text-pretty">{hint}</p>
    )}
  </div>
);

const NextDueNote = ({ due }: { due: number }) => {
  // eslint-disable-next-line react/hook-use-state -- Capture time when this due notice mounts; its keyed remount refreshes the estimate without impure renders.
  const [now] = useState(Date.now);
  const minutes = Math.max(1, Math.ceil((due - now) / 60_000));
  return (
    <p className="text-muted-foreground text-sm text-pretty">
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
    <div className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertTitle>
          {practice.writeError
            ? t`Could not save your answers`
            : t`Could not load your session`}
          :{" "}
        </AlertTitle>
        <AlertDescription className="[overflow-wrap:anywhere]">
          {practice.writeError ?? practice.loadError}
        </AlertDescription>
      </Alert>
      <p className="text-muted-foreground text-sm text-pretty">
        <Trans>
          Try again before continuing. Do not clear your browser data: it may
          contain answers that have not been saved yet.
        </Trans>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={practice.recovering}
          onClick={() => {
            void practice.retry();
          }}
        >
          {practice.recovering && (
            <Spinner aria-hidden="true" data-icon="inline-start" />
          )}
          <Trans>Try again</Trans>
        </Button>
        {practice.syncConflict && (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  variant="destructive"
                  className="h-auto min-h-8 max-w-full min-w-0 shrink whitespace-normal"
                />
              }
              disabled={practice.recovering}
            >
              <Trans>Delete unsynced answers and reload</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Delete unsynced answers and reload</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    Delete all unsynced answers on this device? This cannot be
                    undone. Progress already saved will not change.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  className="h-auto min-h-8 max-w-full min-w-0 shrink whitespace-normal"
                  onClick={() => practice.discard()}
                  disabled={practice.recovering}
                >
                  <Trans>Delete unsynced answers and reload</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
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
      <output className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner aria-hidden="true" />
        <Trans>Loading…</Trans>
      </output>
    );
  }

  return (
    // A new card remounts its input; the effect above restores answer focus.
    <div
      className="flex flex-col gap-6"
      key={`${view.phase}:${promptGloss ?? ""}`}
    >
      {view.phase === "guess" && (
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            act(() => practice.submitGuess(typed));
          }}
        >
          <p className="text-muted-foreground text-sm">
            <Trans>new word · take a guess</Trans>
          </p>
          <Prompt
            image={view.prompt.image}
            gloss={view.prompt.gloss}
            hint={view.prompt.hint}
          />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="guess-answer" className="sr-only">
                <Trans>type the French word</Trans>
              </FieldLabel>
              <Input
                id="guess-answer"
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={t`how do you say it in French?`}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
          </FieldGroup>
          {/* Empty is a valid answer: a shrug is a legitimate pretest (§3). */}
          <div className="flex flex-wrap gap-2">
            <Button type="submit">
              <Trans>Continue</Trans>
            </Button>
          </div>
        </form>
      )}
      {view.phase === "exposure" && (
        <>
          <p className="text-muted-foreground text-sm">
            <Trans>listen and repeat aloud</Trans>
          </p>
          {view.prompt.image && <p className="text-5xl">{view.prompt.image}</p>}
          <p
            lang="fr"
            className="text-4xl font-semibold [overflow-wrap:anywhere]"
          >
            {view.answer}
          </p>
          <p className="text-xl text-pretty">{view.prompt.gloss}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => speak(view.answer, setAudioError)}
            >
              <Trans>Listen again</Trans>
            </Button>
            <Button
              type="button"
              onClick={() => act(() => practice.exposureDone())}
            >
              <Trans>I&apos;ve said it aloud</Trans>
            </Button>
          </div>
        </>
      )}
      {view.phase === "recall" && (
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter means Good: no separate grading decision on the default path.
            act(() => practice.submitRecall(typed, "good"));
          }}
        >
          <p className="text-muted-foreground text-sm">
            <Trans>type the French word</Trans>
          </p>
          <Prompt
            image={view.prompt.image}
            gloss={view.prompt.gloss}
            hint={view.prompt.hint}
          />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="recall-answer" className="sr-only">
                <Trans>type the French word</Trans>
              </FieldLabel>
              <Input
                id="recall-answer"
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            {/* The session decides which effort choices are offered. */}
            {view.efforts.map((effort) => (
              <Button
                key={effort}
                type={effort === "good" ? "submit" : "button"}
                variant={effort === "good" ? "default" : "ghost"}
                onClick={
                  effort === "good"
                    ? undefined
                    : () => act(() => practice.submitRecall(typed, effort))
                }
              >
                {effortLabel[effort]}
              </Button>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">
            <Trans>
              <Kbd>Enter</Kbd> = Good
            </Trans>
          </p>
        </form>
      )}
      {view.phase === "feedback" && (
        <>
          <p className="text-destructive text-sm">
            <Trans>not quite</Trans>
          </p>
          <p
            lang="fr"
            className="text-4xl font-semibold [overflow-wrap:anywhere]"
          >
            {view.expected}
          </p>
          {/* No diff highlighting: finding the difference is the point (§2). */}
          <p className="text-muted-foreground text-sm text-pretty [overflow-wrap:anywhere]">
            <Trans>
              you wrote: <b>{view.typed || "—"}</b>
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => act(() => practice.dismissFeedback())}
            >
              <Trans>Continue</Trans>
            </Button>
          </div>
        </>
      )}
      {view.phase === "caughtUp" && (
        <>
          <p className="text-muted-foreground text-sm">
            <Trans>you&apos;re all caught up</Trans>
          </p>
          <h1 className="text-3xl font-semibold text-balance">
            <Trans>All done, for now</Trans>
          </h1>
          <SessionStats {...view.stats} />
          <NextDueNote
            key={view.nextDueAt.getTime()}
            due={view.nextDueAt.getTime()}
          />
        </>
      )}
      {view.phase === "done" && (
        <>
          <p className="text-muted-foreground text-sm">
            <Trans>session complete</Trans>
          </p>
          <h1 className="text-3xl font-semibold text-balance">
            <Trans>Well done</Trans>
          </h1>
          <SessionStats {...view.stats} />
        </>
      )}
      {audioError && (
        <Alert>
          <AlertDescription>
            {audioError.kind === "unsupported"
              ? t`This browser does not support reading words aloud.`
              : t`Could not play the audio (${audioError.reason}).`}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
};

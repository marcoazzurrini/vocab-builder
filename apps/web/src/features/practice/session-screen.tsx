import { Trans, useLingui } from "@lingui/react/macro";
import type { Effort, SessionView } from "@vocab/spaced-repetition";
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

import { BlockPanel, BlockProgress } from "./block-controls";
import { DictionaryEntry } from "./dictionary-entry";
import { speak, warmUpVoices } from "./speak";
import type { SpeechFailure } from "./speak";
import type { PracticeTransport } from "./transport";
import { usePracticeSession } from "./use-practice-session";

const Prompt = ({
  gloss,
  hint,
  meaning,
  context,
  grammar,
}: {
  gloss: string;
  hint: string | null;
  meaning?: string;
  context?: string | null;
  grammar?: string | null;
}) => (
  <div className="flex flex-col gap-4">
    <p className="text-muted-foreground text-xs tracking-widest uppercase">
      <Trans>Italian cue</Trans>
    </p>
    <h1
      lang="it"
      className="font-serif text-4xl leading-tight font-normal tracking-tight text-pretty [overflow-wrap:anywhere] sm:text-5xl"
    >
      {meaning ?? gloss}
    </h1>
    {grammar && (
      <p lang="it" className="text-muted-foreground text-sm">
        {grammar}
      </p>
    )}
    {context && (
      <p
        lang="it"
        className="text-muted-foreground max-w-prose text-base leading-relaxed text-pretty"
      >
        {context}
      </p>
    )}
    {hint && (
      <p className="text-muted-foreground text-sm text-pretty">{hint}</p>
    )}
  </div>
);

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

const RevealNote = ({ text }: { text?: string }) =>
  text ? (
    <p className="text-muted-foreground text-sm text-pretty">{text}</p>
  ) : null;

const RecallInstruction = ({ kind }: { kind: "word" | "chunk" }) => (
  <p className="text-muted-foreground text-sm leading-relaxed">
    {kind === "word" ? (
      <Trans>
        Write only the French word. The context clarifies its meaning; do not
        translate the whole description.
      </Trans>
    ) : (
      <Trans>Write the French expression you learned.</Trans>
    )}
  </p>
);

const AudioStatus = ({ error }: { error: SpeechFailure | null }) => {
  const { t } = useLingui();
  // A blocked autoplay attempt needs no callout: Listen remains available.
  if (!error || (error.kind === "failed" && error.reason === "not-allowed")) {
    return null;
  }
  return (
    <Alert>
      <AlertDescription>
        {error.kind === "unsupported"
          ? t`This browser does not support reading words aloud.`
          : t`Could not play the audio (${error.reason}).`}
      </AlertDescription>
    </Alert>
  );
};

const Feedback = ({
  view,
  onContinue,
}: {
  view: Extract<SessionView, { phase: "feedback" }>;
  onContinue: () => void;
}) => (
  <>
    <p className="text-destructive text-sm">
      <Trans>not quite</Trans>
    </p>
    <p
      lang="fr"
      className="font-serif text-5xl leading-tight font-normal tracking-tight [overflow-wrap:anywhere]"
    >
      {view.expected}
    </p>
    {view.presentation && (
      <p lang="it" className="text-xl text-pretty">
        {view.presentation.meaning}
      </p>
    )}
    <RevealNote text={view.presentation?.explanation ?? view.revealNote} />
    {/* No diff highlighting: finding the difference is the point (§2). */}
    <p className="text-muted-foreground text-sm text-pretty [overflow-wrap:anywhere]">
      <Trans>
        you wrote: <b>{view.typed || "—"}</b>
      </Trans>
    </p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" onClick={onContinue}>
        <Trans>Continue</Trans>
      </Button>
    </div>
  </>
);

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
  const { view, loadError, writeError, blockState } = practice;
  const [audioError, setAudioError] = useState<SpeechFailure | null>(null);
  const [draft, setDraft] = useState<{
    view: SessionView;
    text: string;
  } | null>(null);
  const typed = draft && draft.view === view ? draft.text : "";
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
    if (exposureAnswer && blockState.phase === "running") {
      speak(exposureAnswer, setAudioError);
    }
    return () => window.speechSynthesis?.cancel();
  }, [exposureAnswer, blockState.phase]);

  useEffect(() => {
    if (phase === "recall" && blockState.phase === "running") {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- A new card must refocus the remounted input even when its phase is unchanged.
  }, [phase, promptGloss, blockState.phase]);

  const act = (fn: () => void) => {
    fn();
    setDraft(null);
    setAudioError(null);
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

  if (blockState.phase === "setup" || blockState.phase === "complete") {
    return <BlockPanel practice={practice} />;
  }

  return (
    <>
      {blockState.phase === "paused" && <BlockPanel practice={practice} />}
      {/* Keep the current input mounted while paused, including its draft. */}
      <div hidden={blockState.phase === "paused"}>
        {/* A new card remounts its input; the effect above restores answer focus. */}
        <div
          className="flex flex-col gap-8 py-4 sm:py-8"
          key={`${view.phase}:${promptGloss ?? ""}`}
        >
          <BlockProgress practice={practice} />
          {view.phase === "exposure" && (
            <DictionaryEntry
              answer={view.answer}
              meaning={view.prompt.meaning ?? view.prompt.gloss}
              presentation={view.presentation}
              note={view.revealNote}
              onListen={() => {
                setAudioError(null);
                speak(view.answer, setAudioError);
              }}
              onContinue={() => act(() => practice.exposureDone())}
            />
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
              <p className="text-muted-foreground text-xs tracking-widest uppercase">
                <Trans>Recall</Trans>
              </p>
              <Prompt {...view.prompt} />
              <RecallInstruction kind={view.prompt.kind} />
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="recall-answer" className="sr-only">
                    <Trans>type the French word</Trans>
                  </FieldLabel>
                  <Input
                    id="recall-answer"
                    ref={inputRef}
                    value={typed}
                    onChange={(e) => setDraft({ text: e.target.value, view })}
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
                    size="lg"
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
            <Feedback
              view={view}
              onContinue={() => act(() => practice.dismissFeedback())}
            />
          )}
          <AudioStatus error={audioError} />
        </div>
      </div>
    </>
  );
};

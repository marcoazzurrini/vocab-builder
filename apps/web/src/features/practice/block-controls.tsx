import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { BLOCK_MINUTES } from "./practice-block";
import type { usePracticeSession } from "./use-practice-session";

type Practice = ReturnType<typeof usePracticeSession>;

const StorageNotice = ({ practice }: { practice: Practice }) =>
  practice.blockState.storageUnavailable ? (
    <Alert>
      <AlertDescription>
        <Trans>
          This browser could not remember your session timer. Refreshing may
          reset the timer. Answer saving is separate.
        </Trans>
      </AlertDescription>
    </Alert>
  ) : null;

export const BlockProgress = ({ practice }: { practice: Practice }) => {
  const { t } = useLingui();
  const { elapsedMs, preferences } = practice.blockState;
  const remaining = Math.max(0, preferences.minutes * 60_000 - elapsedMs);
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const label =
    remaining === 0
      ? t`Finish this word at your own pace.`
      : t`About ${minutes} min left`;
  return (
    <section
      aria-label={t`Session progress`}
      className="flex shrink-0 flex-col gap-2"
    >
      <div>
        <p className="text-muted-foreground text-sm tabular-nums">{label}</p>
        <div className="flex items-center gap-3">
          <Progress
            className="min-w-0 flex-1"
            value={Math.floor(
              (elapsedMs / (preferences.minutes * 60_000)) * 100
            )}
            aria-valuetext={label}
          >
            <ProgressLabel className="sr-only">
              <Trans>Practice time</Trans>
            </ProgressLabel>
          </Progress>
          <div className="flex shrink-0 justify-end gap-1">
            <Button
              variant="ghost"
              onClick={() => practice.block.pause(performance.now())}
            >
              <Trans>Pause</Trans>
            </Button>
            <Button
              variant="ghost"
              onClick={() => practice.block.finish(performance.now())}
            >
              <Trans>Finish</Trans>
            </Button>
          </div>
        </div>
      </div>
      <StorageNotice practice={practice} />
    </section>
  );
};

const DurationChoice = ({ practice }: { practice: Practice }) => {
  const { t } = useLingui();
  return (
    <ToggleGroup
      aria-label={t`Practice time goal`}
      className="w-full sm:w-fit"
      variant="outline"
      value={[String(practice.blockState.preferences.minutes)]}
      onValueChange={(values) => {
        const minutes = BLOCK_MINUTES.find(
          (candidate) => String(candidate) === values[0]
        );
        if (minutes) {
          practice.block.setMinutes(minutes);
        }
      }}
    >
      {BLOCK_MINUTES.map((minutes) => (
        <ToggleGroupItem
          key={minutes}
          className="flex-1 sm:flex-none"
          value={String(minutes)}
          aria-label={t`${minutes} minutes`}
        >
          <Trans>{minutes} min</Trans>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

export const BlockPanel = ({ practice }: { practice: Practice }) => {
  const { t, i18n } = useLingui();
  const { phase, reason } = practice.blockState;
  const waiting =
    phase === "complete" &&
    (reason === "caughtUp" || reason === "done") &&
    (practice.view?.phase === "caughtUp" || practice.view?.phase === "done");
  const nextDue =
    practice.view?.phase === "caughtUp"
      ? i18n.date(practice.view.nextDueAt, {
          dateStyle: "short",
          timeStyle: "short",
        })
      : null;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (phase !== "running") {
      heading.current?.focus();
    }
  }, [phase]);
  const title = {
    complete: waiting ? t`You're caught up` : t`Session finished`,
    paused: t`Session paused`,
    running: t`Practice`,
    setup: t`Start session`,
  }[phase];
  return (
    <section className="flex flex-col items-stretch gap-6 py-4 sm:items-start sm:py-8">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-3xl leading-tight font-semibold tracking-tight text-balance outline-none lg:font-serif lg:font-normal"
      >
        {title}
      </h1>
      {phase === "setup" && (
        <>
          <DurationChoice practice={practice} />
          <Button
            size="lg"
            className="w-full sm:w-fit"
            onClick={() => practice.start()}
          >
            <Trans>Start session</Trans>
          </Button>
        </>
      )}
      {phase === "paused" && (
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={() => practice.resume()}>
            <Trans>Resume session</Trans>
          </Button>
          <Button
            variant="ghost"
            onClick={() => practice.block.finish(performance.now())}
          >
            <Trans>Finish</Trans>
          </Button>
        </div>
      )}
      {phase === "complete" && (
        <>
          <p className="text-muted-foreground max-w-prose text-base leading-relaxed text-pretty">
            {waiting && nextDue && (
              <Trans>
                Nothing is due right now. Next review: {nextDue}. Check again
                later for reviews or new words.
              </Trans>
            )}
            {waiting && !nextDue && (
              <Trans>
                No more practice is available right now. Check again tomorrow
                for new words.
              </Trans>
            )}
            {!waiting && (
              <Trans>
                This practice block is finished. Any remaining reviews stay
                scheduled.
              </Trans>
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => practice.block.dismiss()}>
              <Trans>Finish</Trans>
            </Button>
            <Button variant="outline" onClick={() => practice.start()}>
              {waiting ? (
                <Trans>Check again</Trans>
              ) : (
                <Trans>Continue practicing</Trans>
              )}
            </Button>
          </div>
        </>
      )}
      <StorageNotice practice={practice} />
    </section>
  );
};

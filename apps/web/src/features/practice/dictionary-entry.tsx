import { Trans, useLingui } from "@lingui/react/macro";
import type { EntryPresentation } from "@vocab/spaced-repetition";
import { Volume2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Show the meaning and usage together; teaching content is never collapsed. */
export const DictionaryEntry = ({
  answer,
  meaning,
  presentation,
  note,
  onListen,
  onContinue,
}: {
  answer: string;
  meaning: string;
  presentation?: EntryPresentation;
  note?: string;
  onListen: () => void;
  onContinue: () => void;
}) => {
  const { t } = useLingui();
  const explanation = presentation?.explanation ?? note;

  return (
    <article
      className="flex min-h-0 flex-1 flex-col items-start gap-4 [overflow-wrap:anywhere] lg:gap-8"
      aria-labelledby="entry-headword"
    >
      <div className="practice-scroll flex w-full flex-col gap-4 lg:gap-8">
        <header className="flex w-full flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1
              id="entry-headword"
              lang="fr"
              className="min-w-0 text-4xl leading-tight font-semibold tracking-tight text-balance lg:text-5xl"
            >
              {answer}
            </h1>
            <Button
              type="button"
              variant="ghost"
              size="icon-xl"
              aria-label={t`Listen`}
              title={t`Listen`}
              onClick={onListen}
            >
              <Volume2Icon aria-hidden="true" data-icon="inline-start" />
            </Button>
          </div>
          <div
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
            lang="it"
          >
            <p className="text-2xl leading-snug font-medium text-pretty lg:text-3xl">
              {presentation?.meaning ?? meaning}
            </p>
            {presentation?.grammar && (
              <p className="text-muted-foreground text-base leading-snug lg:text-lg">
                {presentation.grammar}
              </p>
            )}
          </div>
        </header>

        {(presentation?.context || explanation) && (
          <div
            className="flex w-full flex-col gap-2 text-base leading-normal text-pretty lg:text-xl lg:leading-relaxed"
            lang="it"
          >
            {presentation?.context && (
              <p className="font-medium">{presentation.context}</p>
            )}
            {explanation && <p>{explanation}</p>}
          </div>
        )}

        {presentation?.example && (
          <figure className="border-border flex w-full flex-col gap-1 border-s-2 ps-3 text-base leading-normal text-pretty lg:ps-5 lg:text-xl lg:leading-relaxed">
            <figcaption className="sr-only">
              <Trans>Example</Trans>
            </figcaption>
            <blockquote lang="fr" className="font-medium">
              {presentation.example.text}
            </blockquote>
            <p lang="it" className="text-muted-foreground">
              {presentation.example.translation}
            </p>
          </figure>
        )}
      </div>
      <Button
        type="button"
        size="xl"
        className="practice-actions w-full max-w-full sm:w-auto"
        onClick={onContinue}
      >
        <Trans>Continue</Trans>
      </Button>
    </article>
  );
};

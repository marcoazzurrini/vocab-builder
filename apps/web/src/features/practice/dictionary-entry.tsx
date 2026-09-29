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
      className="flex flex-col items-start gap-8 [overflow-wrap:anywhere]"
      aria-labelledby="entry-headword"
    >
      <header className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1
            id="entry-headword"
            lang="fr"
            className="min-w-0 text-5xl leading-tight font-semibold tracking-tight text-balance"
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
          <p className="text-3xl leading-snug font-medium text-pretty">
            {presentation?.meaning ?? meaning}
          </p>
          {presentation?.grammar && (
            <p className="text-muted-foreground text-lg leading-relaxed">
              {presentation.grammar}
            </p>
          )}
        </div>
      </header>

      {(presentation?.context || explanation) && (
        <div
          className="flex w-full flex-col gap-3 text-xl leading-relaxed text-pretty"
          lang="it"
        >
          {presentation?.context && (
            <p className="font-medium">{presentation.context}</p>
          )}
          {explanation && <p>{explanation}</p>}
        </div>
      )}

      {presentation?.example && (
        <figure className="border-border flex w-full flex-col gap-1 border-s-2 ps-5 text-xl leading-relaxed text-pretty">
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

      <Button
        type="button"
        size="xl"
        className="max-w-full"
        onClick={onContinue}
      >
        <Trans>Continue</Trans>
      </Button>
    </article>
  );
};

import { Trans } from "@lingui/react/macro";
import type { EntryPresentation } from "@vocab/spaced-repetition";

import { Separator } from "@/components/ui/separator";

/** A dictionary entry, not a question: examples and explanations are teaching-only. */
export const DictionaryEntry = ({
  answer,
  meaning,
  presentation,
  note,
}: {
  answer: string;
  meaning: string;
  presentation?: EntryPresentation;
  note?: string;
}) => (
  <article className="flex flex-col gap-8" aria-labelledby="entry-headword">
    <header className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs tracking-widest uppercase">
        <Trans>French</Trans>
        {presentation?.grammar && (
          <>
            <span aria-hidden="true"> · </span>
            <span lang="it">{presentation.grammar}</span>
          </>
        )}
      </p>
      <h1
        id="entry-headword"
        lang="fr"
        className="font-serif text-5xl leading-tight font-normal tracking-tight text-balance [overflow-wrap:anywhere] sm:text-6xl"
      >
        {answer}
      </h1>
      <p
        lang="it"
        className="text-2xl leading-snug text-pretty [overflow-wrap:anywhere]"
      >
        {presentation?.meaning ?? meaning}
      </p>
    </header>
    <Separator />
    <div className="flex max-w-prose flex-col gap-6">
      {presentation?.context && (
        <div className="flex flex-col gap-2">
          <h2 className="text-muted-foreground text-xs tracking-widest uppercase">
            <Trans>Meaning in this lesson</Trans>
          </h2>
          <p lang="it" className="text-base leading-relaxed text-pretty">
            {presentation.context}
          </p>
        </div>
      )}
      {(presentation?.explanation || note) && (
        <p lang="it" className="text-base leading-relaxed text-pretty">
          {presentation?.explanation ?? note}
        </p>
      )}
      {presentation?.example && (
        <figure className="flex flex-col gap-2 border-s-2 ps-4">
          <figcaption className="text-muted-foreground text-xs tracking-widest uppercase">
            <Trans>Example · not the answer to memorise</Trans>
          </figcaption>
          <blockquote lang="fr" className="font-serif text-xl leading-relaxed">
            {presentation.example.text}
          </blockquote>
          <p
            lang="it"
            className="text-muted-foreground text-base leading-relaxed"
          >
            {presentation.example.translation}
          </p>
        </figure>
      )}
    </div>
  </article>
);

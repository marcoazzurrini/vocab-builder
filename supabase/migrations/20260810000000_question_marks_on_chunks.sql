-- Restore terminal punctuation on the chunks that are complete questions.
--
-- Stored for DISPLAY and AUDIO, not for grading. The comparison strips terminal
-- punctuation from both sides, so the user is never tested on typography — but
-- the reveal shows the real written form, including the French space before `?`.
--
-- The reason this matters beyond looking right: `speechSynthesis` reads
-- "qu'est-ce que c'est ?" with rising question intonation and
-- "qu'est-ce que c'est" flat. For a formulaic sequence the intonation contour is
-- part of the chunk (§7), and audio is a founding principle (§6) — drilling a
-- question that sounds like a statement teaches the wrong thing 40 times over.
--
-- Only complete questions are updated. `où est` stays bare: it is an open
-- fragment ("dov'è…?"), and a question mark on a dangling preposition would be
-- punctuating something that is not a sentence.
--
-- The separator is an ordinary space rather than the typographically correct
-- narrow no-break space (U+202F). An invisible character in the answer column
-- would have to be normalised away at every comparison and would survive
-- copy-paste as a mystery; the visible difference is nil.

update public.words set text = 'qu''est-ce que c''est ?'
  where lang = 'fr' and text = 'qu''est-ce que c''est';

update public.words set text = 'comment ça va ?'
  where lang = 'fr' and text = 'comment ça va';

update public.words set text = 'combien ça coûte ?'
  where lang = 'fr' and text = 'combien ça coûte';

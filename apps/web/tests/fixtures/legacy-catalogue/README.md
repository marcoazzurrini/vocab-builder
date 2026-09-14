# Legacy catalogue fixtures

These SQL files are preserved unchanged from the retired repository-level
Supabase setup:

- `seed.sql`: `20260809000001_seed_starter_deck.sql`.
- `punctuation.sql`: `20260810000000_question_marks_on_chunks.sql`.

The D1 repository test uses them as independent evidence that `data/words.json`
preserves the original 50 entries and subsequent punctuation corrections. They
are test fixtures, not D1 migrations and not configuration for a running Supabase
project. Do not apply them to production.

Other historical Supabase files remain available in Git history before the Bun
workspace migration. Removing those files does not retire the hosted project.

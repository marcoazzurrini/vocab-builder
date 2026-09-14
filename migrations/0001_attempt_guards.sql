-- D1 has no Postgres RLS or per-table grants. Server functions scope ownership;
-- these triggers keep history append-only and check revisions inside the save batch.
CREATE TRIGGER attempts_no_update
BEFORE UPDATE ON attempts
BEGIN
  SELECT RAISE(ABORT, 'attempts_are_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER attempts_no_delete
BEFORE DELETE ON attempts
BEGIN
  SELECT RAISE(ABORT, 'attempts_are_append_only');
END;
--> statement-breakpoint
-- Avoid CASE ... END here: the remote D1 SQL splitter can mistake its END
-- for the end of the trigger. WHERE preserves the same atomic checks.
CREATE TRIGGER attempts_recall_revision
BEFORE INSERT ON attempts
WHEN NEW.phase = 'recall'
BEGIN
  SELECT RAISE(ABORT, 'stale_card_missing_guess') WHERE NOT EXISTS (
    SELECT 1 FROM attempts
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id
      AND card_type = NEW.card_type AND phase = 'guess'
  );
  SELECT RAISE(ABORT, 'stale_card_revision') WHERE NEW.rep_number <> COALESCE((
    SELECT revision FROM cards
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type
  ), 0) + 1;
END;

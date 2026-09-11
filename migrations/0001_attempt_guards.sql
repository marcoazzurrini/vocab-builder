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
CREATE TRIGGER attempts_recall_revision
BEFORE INSERT ON attempts
WHEN NEW.phase = 'recall'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM attempts
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id
      AND card_type = NEW.card_type AND phase = 'guess'
  ) THEN RAISE(ABORT, 'stale_card_missing_guess') END;
  SELECT CASE WHEN NEW.rep_number <> COALESCE((
    SELECT revision FROM cards
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type
  ), 0) + 1 THEN RAISE(ABORT, 'stale_card_revision') END;
END;

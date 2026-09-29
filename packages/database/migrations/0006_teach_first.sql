CREATE TABLE `teachings` (
	`card_type` text DEFAULT 'production' NOT NULL,
	`completed_at` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`initial_recall_at` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`request` text NOT NULL,
	`user_id` text NOT NULL,
	`word_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "teachings_production" CHECK("teachings"."card_type" = 'production'),
	CONSTRAINT "teachings_latency" CHECK("teachings"."latency_ms" between 0 and 86400000),
	CONSTRAINT "teachings_request_json" CHECK(json_valid("teachings"."request")),
	CONSTRAINT "teachings_timestamps" CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', "teachings"."completed_at") is not null and "teachings"."completed_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "teachings"."completed_at") and strftime('%Y-%m-%dT%H:%M:%fZ', "teachings"."completed_at", '+60 seconds') is not null and "teachings"."initial_recall_at" = strftime('%Y-%m-%dT%H:%M:%fZ', "teachings"."completed_at", '+60 seconds'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teachings_one_completion_idx` ON `teachings` (`user_id`,`word_id`,`card_type`);
--> statement-breakpoint
CREATE TRIGGER teachings_no_update
BEFORE UPDATE ON teachings
BEGIN
  SELECT RAISE(ABORT, 'teachings_are_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER teachings_no_delete
BEFORE DELETE ON teachings
BEGIN
  SELECT RAISE(ABORT, 'teachings_are_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER teachings_insert_guard
BEFORE INSERT ON teachings
BEGIN
  -- REPLACE can bypass delete triggers when recursive_triggers is disabled.
  SELECT RAISE(ABORT, 'teachings_are_append_only') WHERE EXISTS (
    SELECT 1 FROM teachings WHERE id = NEW.id
      OR (user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type)
  );
  SELECT RAISE(ABORT, 'history_id_conflict') WHERE EXISTS (
    SELECT 1 FROM attempts WHERE id = NEW.id
  );
  SELECT RAISE(ABORT, 'stale_card_already_rated') WHERE EXISTS (
    SELECT 1 FROM cards
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type
  );
END;
--> statement-breakpoint
CREATE TRIGGER attempts_history_id_guard
BEFORE INSERT ON attempts
BEGIN
  SELECT RAISE(ABORT, 'history_id_conflict') WHERE EXISTS (
    SELECT 1 FROM teachings WHERE id = NEW.id
  );
END;
--> statement-breakpoint
DROP TRIGGER attempts_recall_revision;
--> statement-breakpoint
-- Preserve legacy queued recalls, including their original immediate first recall.
-- Avoid CASE ... END: D1's migration splitter must see complete trigger bodies.
CREATE TRIGGER attempts_recall_revision
BEFORE INSERT ON attempts
WHEN NEW.phase = 'recall'
BEGIN
  SELECT RAISE(ABORT, 'stale_card_missing_guess') WHERE NOT EXISTS (
    SELECT 1 FROM attempts
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id
      AND card_type = NEW.card_type AND phase = 'guess'
  ) AND NOT EXISTS (
    SELECT 1 FROM teachings
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type
  );
  SELECT RAISE(ABORT, 'stale_card_revision') WHERE NEW.rep_number <> COALESCE((
    SELECT revision FROM cards
    WHERE user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type
  ), 0) + 1;
  SELECT RAISE(ABORT, 'stale_card_initial_recall_not_due') WHERE NEW.rep_number = 1
    AND NOT EXISTS (
      SELECT 1 FROM attempts
      WHERE user_id = NEW.user_id AND word_id = NEW.word_id
        AND card_type = NEW.card_type AND phase = 'guess'
    ) AND EXISTS (
      SELECT 1 FROM teachings
      WHERE user_id = NEW.user_id AND word_id = NEW.word_id AND card_type = NEW.card_type
        AND (julianday(NEW.reviewed_at) IS NULL OR julianday(NEW.reviewed_at) < julianday(initial_recall_at))
    );
END;
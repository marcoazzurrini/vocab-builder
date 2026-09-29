CREATE TABLE `catalogue_presentations` (
	`content` text NOT NULL,
	`prompt_id` text NOT NULL,
	`source_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`prompt_id`, `version`),
	FOREIGN KEY (`prompt_id`) REFERENCES `catalogue_prompts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "catalogue_presentation_version" CHECK("catalogue_presentations"."version" > 0),
	CONSTRAINT "catalogue_presentation_json" CHECK(json_valid("catalogue_presentations"."content"))
);
--> statement-breakpoint
CREATE TRIGGER catalogue_presentation_immutable
BEFORE UPDATE ON catalogue_presentations
WHEN NEW.prompt_id IS NOT OLD.prompt_id
  OR NEW.version IS NOT OLD.version
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.content IS NOT OLD.content
BEGIN
  SELECT RAISE(ABORT, 'catalogue_presentation_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER catalogue_presentation_no_delete
BEFORE DELETE ON catalogue_presentations
BEGIN
  SELECT RAISE(ABORT, 'catalogue_presentation_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER catalogue_presentation_no_replace
BEFORE INSERT ON catalogue_presentations
WHEN EXISTS (
  SELECT 1 FROM catalogue_presentations p
  WHERE p.prompt_id = NEW.prompt_id AND p.version = NEW.version
    AND (p.source_id IS NOT NEW.source_id OR p.content IS NOT NEW.content)
)
BEGIN
  SELECT RAISE(ABORT, 'catalogue_presentation_immutable');
END;

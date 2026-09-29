CREATE TABLE `catalogue_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`word_id` text NOT NULL,
	`sense_id` text NOT NULL,
	`language` text NOT NULL,
	`version` integer NOT NULL,
	`cue_type` text DEFAULT 'text' NOT NULL,
	`status` text NOT NULL,
	`source_id` text NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sense_id`) REFERENCES `catalogue_senses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalogue_prompt_version_positive" CHECK("catalogue_prompts"."version" > 0),
	CONSTRAINT "catalogue_prompt_status" CHECK("catalogue_prompts"."status" in ('legacy','machine_draft','reviewed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalogue_prompts_word_id_unique` ON `catalogue_prompts` (`word_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `catalogue_prompt_version` ON `catalogue_prompts` (`sense_id`,`language`,`version`);--> statement-breakpoint
CREATE TABLE `catalogue_families` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`label` text NOT NULL,
	`source_id` text NOT NULL,
	`policy` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `catalogue_family_members` (
	`family_id` text NOT NULL,
	`entry_id` text NOT NULL,
	PRIMARY KEY(`family_id`, `entry_id`),
	FOREIGN KEY (`family_id`) REFERENCES `catalogue_families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `lexical_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `catalogue_frequencies` (
	`entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`unit` text NOT NULL,
	`part_of_speech` text NOT NULL,
	`per_million` real NOT NULL,
	PRIMARY KEY(`entry_id`, `source_id`, `unit`, `part_of_speech`),
	FOREIGN KEY (`entry_id`) REFERENCES `lexical_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalogue_frequency_nonnegative" CHECK("catalogue_frequencies"."per_million" >= 0)
);
--> statement-breakpoint
CREATE TABLE `catalogue_list_members` (
	`list_id` text NOT NULL,
	`sense_id` text NOT NULL,
	`position` integer NOT NULL,
	`frequency_rank` integer NOT NULL,
	PRIMARY KEY(`list_id`, `sense_id`),
	FOREIGN KEY (`list_id`) REFERENCES `catalogue_lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sense_id`) REFERENCES `catalogue_senses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalogue_list_positive_rank" CHECK("catalogue_list_members"."position" > 0 and "catalogue_list_members"."frequency_rank" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalogue_list_position` ON `catalogue_list_members` (`list_id`,`position`);--> statement-breakpoint
CREATE TABLE `catalogue_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`language` text NOT NULL,
	`prompt_language` text NOT NULL,
	`source_id` text NOT NULL,
	`ranking_policy` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalogue_one_default` ON `catalogue_lists` (`language`,`prompt_language`) WHERE "catalogue_lists"."is_default" = 1;--> statement-breakpoint
CREATE TABLE `catalogue_senses` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`description` text NOT NULL,
	`part_of_speech` text,
	`source_id` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `lexical_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `catalogue_senses_entry_idx` ON `catalogue_senses` (`entry_id`);--> statement-breakpoint
CREATE TABLE `catalogue_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`version` text NOT NULL,
	`url` text NOT NULL,
	`license` text NOT NULL,
	`sha256` text
);
--> statement-breakpoint
CREATE TABLE `lexical_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_key` text NOT NULL,
	`forms` text NOT NULL,
	`annotations` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "lexical_entries_kind" CHECK("lexical_entries"."kind" in ('word', 'chunk')),
	CONSTRAINT "lexical_entries_json" CHECK(json_valid("lexical_entries"."forms") and json_valid("lexical_entries"."annotations"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lexical_entries_source_key` ON `lexical_entries` (`source_id`,`language`,`source_key`);--> statement-breakpoint
DROP INDEX `words_lang_text_gloss_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `words_lang_text_gloss_unique` ON `words` (`lang`,`text`,`gloss`,`gloss_lang`);--> statement-breakpoint
ALTER TABLE `settings` ADD `prompt_language` text DEFAULT 'it' NOT NULL;
--> statement-breakpoint
-- Existing words/cards/attempts are intentionally neither rebuilt nor renumbered.
-- New catalogue-linked production prompts cannot change underneath saved attempts.
CREATE TRIGGER catalogue_word_content_immutable BEFORE UPDATE ON words
WHEN EXISTS (SELECT 1 FROM catalogue_prompts WHERE word_id=OLD.id)
AND (NEW.id IS NOT OLD.id OR NEW.lang IS NOT OLD.lang OR NEW.text IS NOT OLD.text
 OR NEW.gloss IS NOT OLD.gloss OR NEW.gloss_lang IS NOT OLD.gloss_lang
 OR NEW.kind IS NOT OLD.kind OR NEW.hint IS NOT OLD.hint OR NEW.image IS NOT OLD.image)
BEGIN SELECT RAISE(ABORT, 'Catalogue prompt content is immutable; publish a new prompt version'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_prompt_identity_immutable BEFORE UPDATE ON catalogue_prompts
WHEN NEW.id IS NOT OLD.id OR NEW.word_id IS NOT OLD.word_id OR NEW.sense_id IS NOT OLD.sense_id
 OR NEW.language IS NOT OLD.language OR NEW.version IS NOT OLD.version OR NEW.cue_type IS NOT OLD.cue_type
 OR NEW.source_id IS NOT OLD.source_id OR NEW.content_hash IS NOT OLD.content_hash
BEGIN SELECT RAISE(ABORT, 'Catalogue prompt version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_source_immutable BEFORE UPDATE ON catalogue_sources
WHEN NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version OR NEW.sha256 IS NOT OLD.sha256
 OR NEW.title IS NOT OLD.title OR NEW.url IS NOT OLD.url OR NEW.license IS NOT OLD.license
BEGIN SELECT RAISE(ABORT, 'Catalogue source version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_sense_immutable BEFORE UPDATE ON catalogue_senses
WHEN NEW.id IS NOT OLD.id OR NEW.entry_id IS NOT OLD.entry_id OR NEW.description IS NOT OLD.description
 OR NEW.part_of_speech IS NOT OLD.part_of_speech OR NEW.source_id IS NOT OLD.source_id
BEGIN SELECT RAISE(ABORT, 'Catalogue sense is immutable; create a new sense for a different meaning'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_entry_identity_immutable BEFORE UPDATE ON lexical_entries
WHEN NEW.id IS NOT OLD.id OR NEW.language IS NOT OLD.language OR NEW.text IS NOT OLD.text OR NEW.kind IS NOT OLD.kind
BEGIN SELECT RAISE(ABORT, 'Catalogue entry identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_list_identity_immutable BEFORE UPDATE ON catalogue_lists
WHEN NEW.id IS NOT OLD.id OR NEW.title IS NOT OLD.title OR NEW.language IS NOT OLD.language
 OR NEW.prompt_language IS NOT OLD.prompt_language OR NEW.source_id IS NOT OLD.source_id
 OR NEW.ranking_policy IS NOT OLD.ranking_policy
BEGIN SELECT RAISE(ABORT, 'Catalogue list version is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_frequency_immutable BEFORE UPDATE ON catalogue_frequencies
WHEN NEW.entry_id IS NOT OLD.entry_id OR NEW.source_id IS NOT OLD.source_id
 OR NEW.unit IS NOT OLD.unit OR NEW.part_of_speech IS NOT OLD.part_of_speech
 OR NEW.per_million IS NOT OLD.per_million
BEGIN SELECT RAISE(ABORT, 'Catalogue source frequency is immutable'); END;
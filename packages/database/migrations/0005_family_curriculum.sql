CREATE TABLE `catalogue_curricula` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `catalogue_lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `catalogue_curriculum_steps` (
	`curriculum_id` text NOT NULL,
	`id` text NOT NULL,
	`prompt_id` text NOT NULL,
	`family_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`form_id` text,
	`prerequisite` text,
	`position` integer NOT NULL,
	PRIMARY KEY(`curriculum_id`, `id`),
	FOREIGN KEY (`curriculum_id`) REFERENCES `catalogue_curricula`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_id`) REFERENCES `catalogue_prompts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `catalogue_families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `lexical_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`form_id`) REFERENCES `catalogue_forms`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "curriculum_step_position_positive" CHECK("catalogue_curriculum_steps"."position" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `curriculum_step_position` ON `catalogue_curriculum_steps` (`curriculum_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `curriculum_step_prompt` ON `catalogue_curriculum_steps` (`curriculum_id`,`prompt_id`);--> statement-breakpoint
CREATE INDEX `curriculum_step_family` ON `catalogue_curriculum_steps` (`family_id`);--> statement-breakpoint
CREATE TABLE `catalogue_family_ranks` (
	`resource_id` text NOT NULL,
	`family_id` text NOT NULL,
	`rank` integer NOT NULL,
	`per_million` real NOT NULL,
	PRIMARY KEY(`resource_id`, `family_id`),
	FOREIGN KEY (`resource_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`family_id`) REFERENCES `catalogue_families`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalogue_family_rank_positive" CHECK("catalogue_family_ranks"."rank" > 0 and "catalogue_family_ranks"."per_million" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalogue_family_rank` ON `catalogue_family_ranks` (`resource_id`,`rank`);--> statement-breakpoint
CREATE TABLE `catalogue_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`source_id` text NOT NULL,
	`text` text NOT NULL,
	`part_of_speech` text NOT NULL,
	`per_million` real NOT NULL,
	`gender` text,
	`number` text,
	`verb_info` text,
	FOREIGN KEY (`entry_id`) REFERENCES `lexical_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `catalogue_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalogue_form_frequency" CHECK("catalogue_forms"."per_million" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalogue_form_observation` ON `catalogue_forms` (`entry_id`,`source_id`,`text`,`part_of_speech`);
--> statement-breakpoint
CREATE TRIGGER catalogue_forms_immutable BEFORE UPDATE ON catalogue_forms
WHEN OLD.id IS NOT NEW.id OR OLD.entry_id IS NOT NEW.entry_id OR OLD.source_id IS NOT NEW.source_id
 OR OLD.text IS NOT NEW.text OR OLD.part_of_speech IS NOT NEW.part_of_speech
 OR OLD.per_million IS NOT NEW.per_million OR OLD.gender IS NOT NEW.gender
 OR OLD.number IS NOT NEW.number OR OLD.verb_info IS NOT NEW.verb_info
BEGIN SELECT RAISE(ABORT, 'Form observations are immutable; use a new source version'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_curricula_immutable BEFORE UPDATE ON catalogue_curricula
WHEN OLD.id IS NOT NEW.id OR OLD.resource_id IS NOT NEW.resource_id OR OLD.content_hash IS NOT NEW.content_hash
BEGIN SELECT RAISE(ABORT, 'Curriculum versions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_curriculum_scope BEFORE INSERT ON catalogue_curriculum_steps
WHEN NOT EXISTS (
 SELECT 1 FROM catalogue_prompts p JOIN catalogue_senses s ON s.id=p.sense_id
 JOIN catalogue_family_members m ON m.entry_id=s.entry_id AND m.family_id=NEW.family_id
 WHERE p.id=NEW.prompt_id AND s.entry_id=NEW.entry_id
) OR (NEW.form_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM catalogue_forms f WHERE f.id=NEW.form_id AND f.entry_id=NEW.entry_id
)) OR (NEW.prerequisite IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM catalogue_curriculum_steps s WHERE s.curriculum_id=NEW.curriculum_id
 AND s.id=NEW.prerequisite AND s.position < NEW.position
))
BEGIN SELECT RAISE(ABORT, 'Invalid curriculum target or prerequisite'); END;
--> statement-breakpoint
CREATE TRIGGER catalogue_curriculum_steps_immutable BEFORE UPDATE ON catalogue_curriculum_steps
WHEN OLD.curriculum_id IS NOT NEW.curriculum_id OR OLD.id IS NOT NEW.id OR OLD.prompt_id IS NOT NEW.prompt_id
 OR OLD.family_id IS NOT NEW.family_id OR OLD.entry_id IS NOT NEW.entry_id OR OLD.form_id IS NOT NEW.form_id
 OR OLD.prerequisite IS NOT NEW.prerequisite OR OLD.position IS NOT NEW.position
BEGIN SELECT RAISE(ABORT, 'Curriculum steps are immutable'); END;

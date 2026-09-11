CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_provider_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`word_id` text NOT NULL,
	`card_type` text DEFAULT 'production' NOT NULL,
	`phase` text NOT NULL,
	`typed` text NOT NULL,
	`correct` integer NOT NULL,
	`rating` integer,
	`latency_ms` integer NOT NULL,
	`state_before` text NOT NULL,
	`reviewed_at` text NOT NULL,
	`rep_number` integer NOT NULL,
	`request` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attempts_production" CHECK("attempts"."card_type" = 'production'),
	CONSTRAINT "attempts_grading" CHECK(("attempts"."phase" = 'guess' and "attempts"."rating" is null and "attempts"."rep_number" = 0) or ("attempts"."phase" = 'recall' and "attempts"."rating" between 1 and 4 and "attempts"."rating" is not null and "attempts"."rep_number" > 0 and "attempts"."correct" = ("attempts"."rating" <> 1))),
	CONSTRAINT "attempts_latency" CHECK("attempts"."latency_ms" between 0 and 86400000),
	CONSTRAINT "attempts_json" CHECK(json_valid("attempts"."state_before"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_one_guess_idx` ON `attempts` (`user_id`,`word_id`,`card_type`) WHERE "attempts"."phase" = 'guess';--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_one_revision_idx` ON `attempts` (`user_id`,`word_id`,`card_type`,`rep_number`) WHERE "attempts"."phase" = 'recall';--> statement-breakpoint
CREATE INDEX `attempts_replay_idx` ON `attempts` (`user_id`,`word_id`,`card_type`,`reviewed_at`);--> statement-breakpoint
CREATE TABLE `cards` (
	`user_id` text NOT NULL,
	`word_id` text NOT NULL,
	`card_type` text DEFAULT 'production' NOT NULL,
	`fsrs_state` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`user_id`, `word_id`, `card_type`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cards_production" CHECK("cards"."card_type" = 'production'),
	CONSTRAINT "cards_revision" CHECK("cards"."revision" > 0),
	CONSTRAINT "cards_json" CHECK(json_valid("cards"."fsrs_state"))
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`lang` text DEFAULT 'fr' NOT NULL,
	`new_per_day` integer DEFAULT 15 NOT NULL,
	`day_rollover_hour` integer DEFAULT 4 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "settings_allowance" CHECK("settings"."new_per_day" between 0 and 100),
	CONSTRAINT "settings_rollover" CHECK("settings"."day_rollover_hour" between 0 and 23)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `words` (
	`id` text PRIMARY KEY NOT NULL,
	`lang` text NOT NULL,
	`text` text NOT NULL,
	`gloss` text NOT NULL,
	`gloss_lang` text DEFAULT 'it' NOT NULL,
	`hint` text,
	`image` text,
	`kind` text DEFAULT 'word' NOT NULL,
	`freq_rank` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "words_kind" CHECK("words"."kind" in ('word', 'chunk'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `words_lang_text_gloss_unique` ON `words` (`lang`,`text`,`gloss`);--> statement-breakpoint
CREATE INDEX `words_lang_freq_rank_idx` ON `words` (`lang`,`freq_rank`);
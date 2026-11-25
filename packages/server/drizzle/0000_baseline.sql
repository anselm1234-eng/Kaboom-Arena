CREATE TABLE IF NOT EXISTS `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text,
	`password_hash` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`nickname` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `accounts_email_unique` ON `accounts` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_auth_sessions_account` ON `auth_sessions` (`account_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bricks` (
	`id` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`status` text NOT NULL,
	`display_name` text NOT NULL,
	`link_url` text,
	`tile_paths` text NOT NULL,
	`full_path` text NOT NULL,
	`original_path` text NOT NULL,
	`order_id` integer,
	`license_key_id` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`reject_reason` text,
	`appearances` integer DEFAULT 0 NOT NULL,
	`tiles_destroyed` integer DEFAULT 0 NOT NULL,
	`fully_destroyed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bricks_status` ON `bricks` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bricks_order` ON `bricks` (`order_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `email_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`purpose` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_email_tokens_account` ON `email_tokens` (`account_id`,`purpose`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `processed_webhooks` (
	`event_key` text PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `skin_activations` (
	`license_key_id` integer NOT NULL,
	`instance_id` text NOT NULL,
	`activated_at` integer NOT NULL,
	PRIMARY KEY(`license_key_id`, `instance_id`)
);

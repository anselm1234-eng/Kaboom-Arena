ALTER TABLE `accounts` ADD `is_admin` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `accounts` SET `is_admin` = 1 WHERE `email` = 'martin.boksa@gmail.com';
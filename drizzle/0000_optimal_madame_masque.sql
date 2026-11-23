CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `followups` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`status` text NOT NULL,
	`due_at` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `followup_due_idx` ON `followups` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `followup_lead_idx` ON `followups` (`lead_id`);--> statement-breakpoint
CREATE TABLE `leads` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `lead_customer_idx` ON `leads` (`customer_id`);--> statement-breakpoint
CREATE INDEX `lead_status_idx` ON `leads` (`status`);--> statement-breakpoint
CREATE TABLE `members` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	CONSTRAINT "member_role_valid" CHECK("members"."role" IN ('OWNER','MANAGER','SALES','OPERATIONS','VIEWER'))
);
--> statement-breakpoint
CREATE TABLE `mutation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	CONSTRAINT "workspace_revision_matches" CHECK("mutation_guards"."ok" = 1)
);
--> statement-breakpoint
CREATE TABLE `mutation_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`payload_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`message` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `members`(`user_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `quotations` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_id` text NOT NULL,
	`number` text,
	`status` text NOT NULL,
	`revision_of` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`revision_of`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_number_unique` ON `quotations` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `quotation_revision_unique` ON `quotations` (`revision_of`);--> statement-breakpoint
CREATE INDEX `quotation_lead_idx` ON `quotations` (`lead_id`);--> statement-breakpoint
CREATE TABLE `workorders` (
	`id` text PRIMARY KEY NOT NULL,
	`quote_id` text NOT NULL,
	`number` text NOT NULL,
	`status` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`payload_json` text NOT NULL,
	FOREIGN KEY (`quote_id`) REFERENCES `quotations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workorder_quote_unique` ON `workorders` (`quote_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workorder_number_unique` ON `workorders` (`number`);--> statement-breakpoint
CREATE INDEX `workorder_status_idx` ON `workorders` (`status`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`company_json` text NOT NULL,
	`sequences_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "workspace_singleton" CHECK("workspaces"."id" = 1),
	CONSTRAINT "workspace_revision_positive" CHECK("workspaces"."revision" >= 0)
);

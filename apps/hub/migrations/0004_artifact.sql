-- Unify collateral into a first-class `artifact` model with versioning.
-- Recreate (not rename): the db-setup runner only guards CREATE TABLE / ADD
-- CONSTRAINT, so RENAME would not be idempotent. Dev data loss is acceptable.
DROP TABLE IF EXISTS "collateral_version";
--> statement-breakpoint
DROP TABLE IF EXISTS "collateral_item";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_id" uuid,
	"pain_point_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact" ADD CONSTRAINT "artifact_session_id_workbench_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workbench_session"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact" ADD CONSTRAINT "artifact_parent_id_artifact_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact" ADD CONSTRAINT "artifact_pain_point_id_pain_point_id_fk" FOREIGN KEY ("pain_point_id") REFERENCES "public"."pain_point"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

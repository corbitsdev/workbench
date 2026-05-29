import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const sessionStatus = ["analyzing", "reviewing", "generating", "improving", "exporting", "done"] as const;
export const severity = ["low", "medium", "high", "critical"] as const;
export const collateralType = ["email", "linkedin", "one-pager", "battlecard"] as const;
export const collateralStatus = ["draft", "approved", "rejected"] as const;
export const transcriptSource = ["paste", "granola"] as const;

export const transcript = pgTable("transcript", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  source: text("source", { enum: transcriptSource }).notNull().default("paste"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const workbenchSession = pgTable("workbench_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  transcriptId: uuid("transcript_id")
    .notNull()
    .references(() => transcript.id, { onDelete: "cascade" }),
  status: text("status", { enum: sessionStatus }).notNull().default("analyzing"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});

export const painPoint = pgTable("pain_point", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => workbenchSession.id, { onDelete: "cascade" }),
  severity: text("severity", { enum: severity }).notNull(),
  context: text("context").notNull(),
  quote: text("quote").notNull(),
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const collateralItem = pgTable("collateral_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  painPointId: uuid("pain_point_id")
    .notNull()
    .references(() => painPoint.id, { onDelete: "cascade" }),
  type: text("type", { enum: collateralType }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: text("status", { enum: collateralStatus }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().$onUpdate(() => new Date()),
});

export const collateralVersion = pgTable("collateral_version", {
  id: uuid("id").primaryKey().defaultRandom(),
  collateralId: uuid("collateral_id")
    .notNull()
    .references(() => collateralItem.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

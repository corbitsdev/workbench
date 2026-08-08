// Shared dependency and result shapes for the folded-run machinery.
// Every side effect that touches a real host — the database, the
// session service, the sidecar router, the event-collector
// registry — arrives as an injected port; this package never imports
// a hub or a host-specific package such as `@corbits/chat`.
import type { DB } from "@intx/db";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";

export type FoldedRunsDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  eventCollectors: EventCollectorRegistry;
};

export type SentFoldedMail = {
  readonly id: string;
  readonly createdAt: string;
};

export type ListedFoldedMailItem = {
  readonly id: string;
  readonly createdAt: string;
  readonly mail: unknown;
};

export type ListedFoldedMail = {
  readonly items: readonly ListedFoldedMailItem[];
  readonly nextCursor?: string;
};

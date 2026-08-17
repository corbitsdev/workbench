// Shared dependency and result shapes for the folded-run machinery.
// Every side effect that touches a real host — the database, the
// session service, the sidecar router, the event-collector
// registry — arrives as an injected port; this package never imports
// a hub or a host-specific package such as `@corbits/chat`.
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
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
  /**
   * Decrypts credential secrets when a launch resolves inference sources
   * against the tenant catalog (`resolveDefinitionSources`, called from
   * `deployAtHead`). Optional: omitted, `resolveDefinitionSources` falls
   * back to a noop cipher that returns a stored secret unchanged — correct
   * only when the secret was itself written unencrypted. The composition
   * root (`apps/hub`) must supply the same real cipher its credential
   * write route encrypts with, or every folded-run launch (channel hosts,
   * invited agents, routines, tasks) decrypts nothing and hands the raw
   * ciphertext to the provider as its API key.
   */
  credentialCipher?: CredentialCipher;
  /**
   * The hub's hex-encoded Ed25519 signing public key — the same value the
   * sidecar router is created with. `deployAtHead` deploys a folded run
   * as an explicit single-step workflow (so it can declare the step's
   * `triggers: "unbounded"` budget) and that deploy carries the hub key.
   */
  hubPublicKey: string;
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

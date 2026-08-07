// The hub-side `ChatPlatform` implementation, owned by this package
// rather than by `apps/hub` — "apps stay generic; packages own the
// domain" applies to the platform port exactly as it does to the rest
// of chat's behavior. `createHubChatPlatform` composes the port
// entirely from services a host already builds (`SessionService`,
// `AssetService`, `SidecarRouter`, `db`, and the grant store); every
// call here is in-process, and nothing self-calls the hub's own HTTP
// surface.
//
// `launchChannel` launches the channel host (see `channel-workflow.ts`)
// as a folded interactive instance — the same shape and the same
// address family `POST /workflows/runs` produces (see
// `vendor/intx/hub-api/src/routes/instances.ts`, this module's
// reference implementation) — rather than through the native
// `sessionService.deployWorkflowDefinition` path. A workflow-deploy
// anchor is a *deployment* run (`workflow_run.deploymentId` set, no
// `principalId`), which is a different address family than a folded
// run and is never resolved by the platform's own run-scoped mail
// surfaces; a folded run (`deploymentId: null`, `principalId` set,
// its session found by joining `agent_session` on that principal) is
// what makes the anchor's mailbox actually listable through the
// platform's sanctioned per-run surfaces. The definition needs no
// working model for its own replies (its system prompt forbids
// replying at all), but the folded launch path still resolves and
// pins a real inference source chain against the tenant catalog —
// that catalog seeding is a deploy-time precondition of this address
// family, not an inference requirement of the anchor.
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import {
  agentSession,
  principal as principalTable,
  sessionMail,
  workflowRun,
} from "@intx/db/schema";
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { generateId } from "@intx/hub-common";
import { extractPartByPath, parseMailToEmail } from "@intx/mime";
import {
  ensureWorkflowDefinitionForAsset,
  resolveRunSessionId,
} from "@intx/hub-sessions";
import type {
  AssetService,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import { resolveDefinitionSources } from "@intx/hub-api";
import { extractFoldedBody } from "@intx/workflow-deploy";
import type { CryptoProvider } from "@intx/types/runtime";
import type { WorkflowDefinition } from "@intx/workflow";
import type {
  ChatChannelEvent,
  ChatPlatform,
  LaunchedChannel,
  ListedMail,
  SentMail,
} from "./routes";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
};

const BLOB_ID_PATTERN = /^blob_(.+?)_(\d[\d.]*)$/;
const MAIL_PAGE_SIZE = 50;

// Asset names are constrained to `^[a-z0-9]+(-[a-z0-9]+)*$`; a channel
// id (`generateId("instance")`) may carry characters outside that set,
// so this derives a compliant name deterministically rather than
// storing a second identifier.
function assetNameForChannel(channelId: string): string {
  return channelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function domainOf(address: string): string {
  const at = address.indexOf("@");
  if (at === -1) {
    throw new Error(`malformed agent address, missing "@": ${address}`);
  }
  return address.slice(at + 1);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf-8"),
  ) as {
    createdAt: string;
    id: string;
  };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

/**
 * Composes the `ChatPlatform` port over the hub's real session
 * services. One crypto provider is minted per channel (mirroring the
 * per-instance signing-key cache the platform's own mail route keeps)
 * and cached for the adapter's lifetime.
 */
export function createHubChatPlatform(
  deps: CreateHubChatPlatformDeps,
): ChatPlatform {
  const cryptoProviders = new Map<string, Promise<CryptoProvider>>();

  function cryptoProviderFor(channelId: string): Promise<CryptoProvider> {
    let pending = cryptoProviders.get(channelId);
    if (pending !== undefined) return pending;
    pending = generateKeyPair().then((keyPair) => createEd25519Crypto(keyPair));
    cryptoProviders.set(channelId, pending);
    return pending;
  }

  async function findChannelRun(channelId: string) {
    return deps.db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, channelId),
    });
  }

  /**
   * Resolves a folded run's session id via the shared-principal bridge
   * (`resolveRunSessionId`) rather than any name derived from the
   * channel id — that bridge is what makes the run's mail listable
   * through the platform's own sanctioned per-run surfaces.
   */
  async function sessionIdForRun(run: {
    principalId: string | null;
  }): Promise<string> {
    const sessionId = await resolveRunSessionId(deps.db, run.principalId, {
      includeEnded: true,
    });
    if (sessionId === null) {
      throw new Error(
        "no agent_session found for this channel run's principal; " +
          "the folded launch may not have completed",
      );
    }
    return sessionId;
  }

  return {
    async launchChannel(input): Promise<LaunchedChannel> {
      // Validates the address shape early, mirroring every other path
      // here that reads a domain off an agent address.
      domainOf(input.triggerAddress);
      const asset = await deps.assetService.createAsset({
        tenantId: input.tenantId,
        kind: "workflow",
        name: assetNameForChannel(input.channelId),
        creatorPrincipalId: input.creatorPrincipalId,
      });
      const { definitionId } = await ensureWorkflowDefinitionForAsset(
        deps.db,
        asset.id,
      );

      const definition = JSON.parse(input.definition) as WorkflowDefinition;
      const foldedBody = extractFoldedBody(definition);

      // The anchor's inference sources are resolved against the tenant
      // catalog exactly like any folded launch, even though the anchor
      // never actually performs inference — the folded address family
      // requires a resolvable source chain to launch at all (see the
      // module doc). A tenant with no seeded catalog source cannot
      // create channels until one exists (the workbench seed provides
      // one); that is a deploy-time precondition, surfaced loudly here
      // rather than silently launching an unlistable anchor.
      // This definition carries no `modelRequirements` manifest (it is
      // synthesized fresh per channel, never authored against one), so
      // resolution always derives requirements from the folded step's
      // own declared model, exactly like a manifest-less definition
      // launched through `POST /workflows/runs`.
      const resolution = await resolveDefinitionSources({
        db: deps.db,
        tenantId: input.tenantId,
        modelRequirements: null,
        fallbackModel: foldedBody.model,
        invokerPreferences: {},
      });
      if (!resolution.ok) {
        throw new Error(
          `launchChannel: cannot resolve an inference source for the ` +
            `channel host (${resolution.message}); seed a tenant catalog ` +
            `source (provider, credential, catalog model/provider/offering) ` +
            `before creating channels`,
        );
      }

      const instancePrincipalId = generateId("principal");
      const sessionId = generateId("session");
      const now = new Date();

      await deps.db.transaction(async (tx) => {
        // A folded run's principal is `workflow`-kind, converging on
        // the native run's principal shape; its `refId` is the
        // instance id, matching `POST /workflows/runs`.
        await tx.insert(principalTable).values({
          id: instancePrincipalId,
          tenantId: input.tenantId,
          kind: "workflow",
          refId: input.channelId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });

        // The session is keyed to the folded definition (`agentId`)
        // and to the run's own principal — the shared-principal
        // bridge `resolveRunSessionId`/`resolveRunIdForSession` read.
        await tx.insert(agentSession).values({
          id: sessionId,
          tenantId: input.tenantId,
          agentId: definitionId,
          principalId: instancePrincipalId,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });

        // The folded run IS the launched channel: `deploymentId` is
        // null (a folded run has no deployment), which is what puts
        // it in the address family the platform's run-scoped mail
        // surfaces actually resolve.
        await tx.insert(workflowRun).values({
          id: input.channelId,
          definitionId,
          deploymentId: null,
          tenantId: input.tenantId,
          principalId: instancePrincipalId,
          address: input.triggerAddress,
          status: "running",
          modelPreferences: null,
          createdAt: now,
        });
      });

      await deps.sessionService.deployInstanceAtHead({
        agentAddress: input.triggerAddress,
        agentId: input.channelId,
        instanceId: input.channelId,
        config: {
          sessionId,
          agentId: input.channelId,
          tenantId: input.tenantId,
          principalId: instancePrincipalId,
          agentAddress: input.triggerAddress,
          systemPrompt: foldedBody.systemPrompt,
          tools: [],
          grants: [],
          sources: resolution.sources,
          defaultSource: resolution.defaultSource,
        },
        deployContent: { systemPrompt: foldedBody.systemPrompt },
        toolPackagePins: foldedBody.toolPackagePins,
      });

      return { instanceId: input.channelId };
    },

    async sendMail(input): Promise<SentMail> {
      const run = await findChannelRun(input.channelId);
      if (run === undefined) {
        throw new Error(`sendMail: no channel run for "${input.channelId}"`);
      }
      if (run.address === null) {
        throw new Error(
          `sendMail: channel run "${input.channelId}" has no address`,
        );
      }

      const sessionId = await sessionIdForRun(run);
      const mailId = crypto.randomUUID();
      const now = new Date();
      const domain = domainOf(run.address);
      const from = `${input.principalId}@${domain}`;
      const cryptoProvider = await cryptoProviderFor(input.channelId);

      const attachments = input.content.attachments?.map(
        (attachment, index) => ({
          name: attachment.name ?? `attachment-${index}`,
          contentType: attachment.mimeType,
          data: new Uint8Array(Buffer.from(attachment.data, "base64")),
        }),
      );

      const rawMIME = await deps.sessionService.sendUserMessage({
        agentAddress: run.address,
        from,
        messageId: `<${mailId}@${domain}>`,
        date: now,
        content: input.content.content,
        ...(attachments !== undefined ? { attachments } : {}),
        ...(input.content.replyTo !== undefined
          ? { inReplyTo: input.content.replyTo }
          : {}),
        sessionId,
        tenantId: input.tenantId,
        cryptoProvider,
      });

      const mailCreatedAt = new Date();
      await deps.db.insert(sessionMail).values({
        id: mailId,
        sessionId,
        instanceId: null,
        tenantId: input.tenantId,
        direction: "inbound",
        status: "delivered",
        raw: rawMIME,
        createdAt: mailCreatedAt,
      });

      deps.sidecarRouter.dispatchAgentEvent(run.address, {
        type: "mail.delivered",
        data: {
          id: mailId,
          direction: "inbound",
          receivedAt: mailCreatedAt.toISOString(),
        },
      });

      return { id: mailId, createdAt: mailCreatedAt.toISOString() };
    },

    async listMail(input): Promise<ListedMail> {
      const run = await findChannelRun(input.channelId);
      if (run === undefined) {
        throw new Error(`listMail: no channel run for "${input.channelId}"`);
      }
      const sessionId = await sessionIdForRun(run);

      const conditions = [
        eq(sessionMail.tenantId, input.tenantId),
        eq(sessionMail.sessionId, sessionId),
      ];

      const rows = await deps.db
        .select()
        .from(sessionMail)
        .where(and(...conditions))
        .orderBy(desc(sessionMail.createdAt), desc(sessionMail.id))
        .limit(MAIL_PAGE_SIZE + 1);

      const page =
        input.cursor === undefined
          ? rows
          : (() => {
              const { createdAt, id } = decodeCursor(input.cursor as string);
              const startIndex = rows.findIndex(
                (row) =>
                  row.createdAt.getTime() === createdAt.getTime() &&
                  row.id === id,
              );
              return startIndex === -1 ? [] : rows.slice(startIndex + 1);
            })();

      const hasMore = page.length > MAIL_PAGE_SIZE;
      const items = page.slice(0, MAIL_PAGE_SIZE).map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        mail: parseMailToEmail(row.raw, row.id),
      }));

      const last = items.length > 0 ? page[items.length - 1] : undefined;
      return {
        items,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeCursor(last.createdAt, last.id) }
          : {}),
      };
    },

    async fetchBlob(_channelId, blobId): Promise<string | Uint8Array> {
      const match = BLOB_ID_PATTERN.exec(blobId);
      if (match === null) {
        throw new Error(`fetchBlob: invalid blob id "${blobId}"`);
      }
      const [, mailId, partPath] = match;
      const mailRow = await deps.db.query.sessionMail.findFirst({
        where: eq(sessionMail.id, mailId as string),
      });
      if (mailRow === undefined) {
        throw new Error(`fetchBlob: no mail "${mailId}" for blob "${blobId}"`);
      }
      return extractPartByPath(mailRow.raw, partPath as string);
    },

    subscribeToChannel(
      channelId: string,
      onEvent: (event: ChatChannelEvent) => void,
    ): () => void {
      let cancelled = false;
      let unsubscribeAgent: (() => void) | undefined;

      void findChannelRun(channelId).then((run) => {
        if (cancelled || run === undefined || run.address === null) return;
        unsubscribeAgent = deps.sidecarRouter.subscribeAgent(
          run.address,
          (event) => {
            onEvent({ type: "chat.agent", data: event });
          },
        );
      });

      return () => {
        cancelled = true;
        unsubscribeAgent?.();
      };
    },
  };
}

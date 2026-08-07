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
  tenant as tenantTable,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { generateId } from "@intx/hub-common";
import { extractPartByPath, parseMailToEmail } from "@intx/mime";
import {
  ensureWorkflowDefinitionForAsset,
  resolveRunSessionId,
  SessionLaunchError,
  WORKFLOW_JSON_PATH,
} from "@intx/hub-sessions";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import { resolveDefinitionSources } from "@intx/hub-api";
import { extractFoldedBody } from "@intx/workflow-deploy";
import type { FoldedBody } from "@intx/workflow-deploy";
import { formatAgentAddress } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import type { WorkflowDefinition } from "@intx/workflow";
import type {
  ChatChannelEvent,
  ChatPlatform,
  InvitableDefinition,
  LaunchedChannel,
  LaunchedInvite,
  ListedMail,
  SentMail,
} from "./routes";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  /**
   * Optional only because `apps/hub`'s current `createHubChatPlatform`
   * call site does not build/pass one yet — a separate wiring task
   * needs to add `createEventCollectorRegistry`'s registry here. Until
   * then, `launchChannel` skips opening/abandoning a collector rather
   * than throwing, which reproduces (does not fix) the "anchor reads
   * not_ready forever" gap for that caller specifically; any caller
   * that does pass one gets the fix in full.
   */
  eventCollectors?: EventCollectorRegistry;
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

// Every channel host's workflow asset is named via `assetNameForChannel`
// off a `generateId("instance")` id (`ins_<hex>`), which always yields
// this prefix once slugified — `listInvitableDefinitions` uses it to
// exclude channel hosts from the invitable set without needing a
// separate "is this a channel host" column.
const CHANNEL_HOST_ASSET_NAME_PREFIX = "ins-";

/**
 * Reads a workflow definition's body back out of its materialized
 * asset. Reimplemented here rather than imported from
 * `@intx/hub-api`'s `run-grant-materialization.ts` (the reference
 * `POST /workflows/runs` route's own helper): that module is
 * hub-api-internal, not part of its published surface, matching the
 * same module-privacy reason `channel-workflow.ts` reimplements
 * `assertJsonPortable` rather than reaching into another package's
 * internals.
 */
async function hydrateDefinitionFromAsset(
  assetService: AssetService,
  assetId: string,
): Promise<WorkflowDefinition> {
  const raw = await assetService.readAssetBlob({
    assetId,
    path: WORKFLOW_JSON_PATH,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    throw new Error(
      `workflow asset ${assetId} ${WORKFLOW_JSON_PATH} is not valid JSON`,
      { cause },
    );
  }
  return parsed as WorkflowDefinition;
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

  /**
   * The launch core shared by `launchChannel` (host) and `launchInvite`
   * (invited agent): resolve inference sources against the tenant
   * catalog, write the folded run's principal/session/run rows, open
   * the event collector, and deploy via `deployInstanceAtHead` — with
   * the same failure-path cleanup either caller needs on a deploy
   * failure. Only how the launch body (`foldedBody`) and the instance's
   * identity (`instanceId`/`triggerAddress`/`definitionId`) are sourced
   * differs between the two callers; that sourcing stays in each of
   * them, not here.
   */
  async function launchCore(params: {
    tenantId: string;
    instanceId: string;
    triggerAddress: string;
    definitionId: string;
    foldedBody: FoldedBody;
    /** Named in the "seed a tenant catalog source" error, e.g. "the channel host" or "the invited agent". */
    launchLabel: string;
  }): Promise<void> {
    // The launched run's inference sources are resolved against the
    // tenant catalog exactly like any folded launch, even when the
    // launched agent never actually performs inference (the channel
    // host) — the folded address family requires a resolvable source
    // chain to launch at all (see the module doc). A tenant with no
    // seeded catalog source cannot launch until one exists; that is a
    // deploy-time precondition, surfaced loudly here rather than
    // silently launching an unlistable run.
    const resolution = await resolveDefinitionSources({
      db: deps.db,
      tenantId: params.tenantId,
      modelRequirements: null,
      fallbackModel: params.foldedBody.model,
      invokerPreferences: {},
    });
    if (!resolution.ok) {
      throw new Error(
        `launch: cannot resolve an inference source for ${params.launchLabel} ` +
          `(${resolution.message}); seed a tenant catalog source (provider, ` +
          `credential, catalog model/provider/offering) before launching`,
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
        tenantId: params.tenantId,
        kind: "workflow",
        refId: params.instanceId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      // The session is keyed to the folded definition (`agentId`)
      // and to the run's own principal — the shared-principal
      // bridge `resolveRunSessionId`/`resolveRunIdForSession` read.
      await tx.insert(agentSession).values({
        id: sessionId,
        tenantId: params.tenantId,
        agentId: params.definitionId,
        principalId: instancePrincipalId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      // The folded run IS the launched instance: `deploymentId` is
      // null (a folded run has no deployment), which is what puts
      // it in the address family the platform's run-scoped mail
      // surfaces actually resolve.
      await tx.insert(workflowRun).values({
        id: params.instanceId,
        definitionId: params.definitionId,
        deploymentId: null,
        tenantId: params.tenantId,
        principalId: instancePrincipalId,
        address: params.triggerAddress,
        status: "running",
        modelPreferences: null,
        createdAt: now,
      });
    });

    // Opened before the deploy call, mirroring the reference route: the
    // run's runtime status/readiness (health, SSE replay) is read off
    // this collector by address, and a launch that never opens one reads
    // as permanently "not_ready" and leaks into the generic instance
    // list with broken health.
    deps.eventCollectors?.create(
      params.triggerAddress,
      params.tenantId,
      sessionId,
      params.instanceId,
    );

    try {
      await deps.sessionService.deployInstanceAtHead({
        agentAddress: params.triggerAddress,
        agentId: params.instanceId,
        instanceId: params.instanceId,
        config: {
          sessionId,
          agentId: params.instanceId,
          tenantId: params.tenantId,
          principalId: instancePrincipalId,
          agentAddress: params.triggerAddress,
          systemPrompt: params.foldedBody.systemPrompt,
          tools: [],
          grants: [],
          sources: resolution.sources,
          defaultSource: resolution.defaultSource,
        },
        deployContent: { systemPrompt: params.foldedBody.systemPrompt },
        toolPackagePins: params.foldedBody.toolPackagePins,
      });
    } catch (err) {
      // Mirrors the reference route's failure-path cleanup: a deploy
      // failure must not leave the just-committed principal/session/run
      // rows behind as a permanently "running" ghost that nothing is
      // listening on.
      deps.eventCollectors?.abandon(params.triggerAddress);

      const failedAt = new Date();

      await deps.db
        .update(agentSession)
        .set({ status: "ended", endedAt: failedAt, updatedAt: failedAt })
        .where(eq(agentSession.id, sessionId));

      const leaked = err instanceof SessionLaunchError && err.leakedAgent;

      // A leaked deploy left a running child; mark the run failed but
      // leave it routable (endedAt null) so the leaked child stays
      // reachable to inspect or clean up. Otherwise roll the run back
      // entirely.
      if (leaked) {
        await deps.db
          .update(workflowRun)
          .set({ status: "failed" })
          .where(eq(workflowRun.id, params.instanceId));
      } else {
        await deps.db
          .delete(workflowRun)
          .where(eq(workflowRun.id, params.instanceId));
      }

      await deps.db
        .update(principalTable)
        .set({ status: "deactivated", updatedAt: failedAt })
        .where(eq(principalTable.id, instancePrincipalId));

      throw err;
    }
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

      await launchCore({
        tenantId: input.tenantId,
        instanceId: input.channelId,
        triggerAddress: input.triggerAddress,
        definitionId,
        foldedBody,
        launchLabel: "the channel host",
      });

      return { instanceId: input.channelId };
    },

    async launchInvite(input): Promise<LaunchedInvite> {
      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, input.definitionId),
          eq(workflowDefinition.tenantId, input.tenantId),
        ),
      });
      if (definitionRow === undefined) {
        throw new Error(
          `launchInvite: no definition "${input.definitionId}" for this tenant`,
        );
      }
      if (definitionRow.status !== "deployed") {
        throw new Error(
          `launchInvite: definition "${input.definitionId}" is not in a ` +
            `launchable state (status: ${definitionRow.status})`,
        );
      }
      if (definitionRow.assetId === null) {
        throw new Error(
          `launchInvite: definition "${input.definitionId}" has not been ` +
            `materialized`,
        );
      }

      const tenantRow = await deps.db.query.tenant.findFirst({
        where: eq(tenantTable.id, input.tenantId),
      });
      if (tenantRow === undefined) {
        throw new Error(`launchInvite: no tenant "${input.tenantId}"`);
      }

      const definition = await hydrateDefinitionFromAsset(
        deps.assetService,
        definitionRow.assetId,
      );
      const foldedBody = extractFoldedBody(definition);
      if (foldedBody.systemPrompt === "") {
        throw new Error(
          `launchInvite: definition "${input.definitionId}" cannot be ` +
            `launched without a system prompt configured`,
        );
      }

      const instanceId = generateId("instance");
      const triggerAddress = formatAgentAddress(instanceId, tenantRow.domain);

      await launchCore({
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.definitionId,
        foldedBody,
        launchLabel: "the invited agent",
      });

      return { instanceId, address: triggerAddress };
    },

    async listInvitableDefinitions(
      tenantId,
    ): Promise<readonly InvitableDefinition[]> {
      const rows = await deps.db.query.workflowDefinition.findMany({
        where: and(
          eq(workflowDefinition.tenantId, tenantId),
          eq(workflowDefinition.status, "deployed"),
        ),
        orderBy: desc(workflowDefinition.createdAt),
      });
      return rows
        .filter((row) => !row.name.startsWith(CHANNEL_HOST_ASSET_NAME_PREFIX))
        .map((row) => ({ id: row.id, name: row.name }));
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

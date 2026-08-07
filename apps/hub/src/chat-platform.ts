// The hub's half of the chat boundary: a `ChatPlatform` (the port
// `@corbits/chat`'s routes depend on) composed entirely from services
// `createHub` already builds -- `SessionService`, `AssetService`,
// `SidecarRouter`, and the platform's own `db`/schema. Every call here
// is in-process; nothing self-calls the hub's own HTTP surface.
//
// A channel is a native `WorkflowDefinition` (see
// `@corbits/chat`'s `buildChannelWorkflow`), not a folded single-agent
// instance, so it deploys through `sessionService.deployWorkflowDefinition`
// -- the same "publish as a workflow asset, deploy through the
// platform's deploy machinery" path any native workflow takes -- rather
// than the model-resolution/credential/grant machinery
// `POST /instances` runs for a folded agent. That path leaves no
// `agent_session` row (a deployment's anchor run carries no
// `principalId`), so this module inserts one itself, id'd
// deterministically from the channel id, giving `sendMail`/`listMail`
// something to key `session_mail` rows on without a second store.
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { agentSession, sessionMail, workflowRun } from "@intx/db/schema";
import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { extractPartByPath, parseMailToEmail } from "@intx/mime";
import { ensureWorkflowDefinitionForAsset } from "@intx/hub-sessions";
import type {
  AssetService,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";
import type { CryptoProvider } from "@intx/types/runtime";
import type { WorkflowDefinition } from "@intx/workflow";
import type {
  ChatChannelEvent,
  ChatPlatform,
  LaunchedChannel,
  ListedMail,
  SentMail,
} from "@corbits/chat";

export type CreateHubChatPlatformDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
};

const BLOB_ID_PATTERN = /^blob_(.+?)_(\d[\d.]*)$/;
const MAIL_PAGE_SIZE = 50;

function sessionIdForChannel(channelId: string): string {
  return `session_${channelId}`;
}

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

  return {
    async launchChannel(input): Promise<LaunchedChannel> {
      const deploymentDomain = domainOf(input.triggerAddress);
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

      const sessionId = sessionIdForChannel(input.channelId);
      const definition = JSON.parse(input.definition) as WorkflowDefinition;

      const result = await deps.sessionService.deployWorkflowDefinition({
        tenantId: input.tenantId,
        deploymentId: input.channelId,
        deploymentDomain,
        definition,
        definitionAssetId: asset.id,
        config: {
          sessionId,
          agentId: input.channelId,
          tenantId: input.tenantId,
          principalId: input.creatorPrincipalId,
          agentAddress: input.triggerAddress,
          systemPrompt: "",
          tools: [],
          grants: [],
          sources: [],
          defaultSource: "",
        },
        deployContent: { systemPrompt: "" },
      });

      await deps.db.insert(agentSession).values({
        id: sessionId,
        tenantId: input.tenantId,
        agentId: definitionId,
        principalId: input.creatorPrincipalId,
        status: "active",
      });

      return { instanceId: result.deploymentId };
    },

    async sendMail(input): Promise<SentMail> {
      const run = await findChannelRun(input.channelId);
      if (run === undefined) {
        throw new Error(`sendMail: no channel run for "${input.channelId}"`);
      }

      const sessionId = sessionIdForChannel(input.channelId);
      const mailId = crypto.randomUUID();
      const now = new Date();
      const domain = domainOf(run.address ?? input.channelId);
      const from = `${input.principalId}@${domain}`;
      const cryptoProvider = await cryptoProviderFor(input.channelId);

      if (run.address === null) {
        throw new Error(
          `sendMail: channel run "${input.channelId}" has no address`,
        );
      }

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
      const sessionId = sessionIdForChannel(input.channelId);
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

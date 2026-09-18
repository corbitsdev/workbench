// The mint/use/revoke shape every reader/pusher of an asset's git remote
// needs, pulled out of duplicate copies so a new caller shares this one.
import { type } from "arktype";

export class GitTokenError extends Error {}

const GitTokenMintShape = type({ id: "string", secret: "string" });

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

/** Mints a token scoped to `assetId` on `refs/heads/main`, runs `use` with
 * its secret, and revokes it afterward whether `use` succeeds or throws. */
export async function withGitToken<T>(args: {
  tenantId: string;
  assetId: string;
  actions: readonly ("can_read" | "can_push")[];
  lifetimeMs: number;
  fetchImpl?: typeof fetch;
  use: (token: string) => Promise<T>;
}): Promise<T> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const tokensPath = `/api/tenants/${encodeURIComponent(args.tenantId)}/git-tokens`;
  const minted = await fetchImpl(tokensPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `git-token-${crypto.randomUUID()}`,
      resource: `asset:${args.assetId}`,
      refPattern: "refs/heads/main",
      actions: args.actions,
      expiresAt: new Date(Date.now() + args.lifetimeMs).toISOString(),
    }),
  });
  if (!minted.ok) {
    throw new GitTokenError(`minting a git token failed: ${await readErrorBody(minted)}`);
  }
  const token = GitTokenMintShape(await minted.json());
  if (token instanceof type.errors) {
    throw new GitTokenError(`the git token came back an unexpected shape: ${token.summary}`);
  }
  try {
    return await args.use(token.secret);
  } finally {
    await fetchImpl(`${tokensPath}/${encodeURIComponent(token.id)}`, { method: "DELETE" });
  }
}

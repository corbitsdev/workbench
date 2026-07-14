import { getLogger } from "@intx/log";
import type { InboxIntakeMember } from "../services/inbox-source-registry";

const log = getLogger(["lib", "slack-member-mapping"]);

/**
 * Resolves a Slack user (scoped to one tenant) to the Workbench member it
 * belongs to. Composable so a future per-user OIDC binding can take
 * precedence over the email heuristic without changing the webhook route —
 * see `composeMemberResolvers`.
 */
export interface SlackMemberResolver {
  resolveMember(
    tenantId: string,
    slackUserId: string,
    signal: AbortSignal,
  ): Promise<InboxIntakeMember | null>;
}

/** Fetch a Slack user's account email for one tenant's workspace. Returns
 * null when the user has no email on file. */
export type SlackUserEmailLookup = (
  tenantId: string,
  slackUserId: string,
  signal: AbortSignal,
) => Promise<string | null>;

interface CacheEntry {
  email: string | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 2_000;

function cacheKey(tenantId: string, slackUserId: string): string {
  return `${tenantId}:${slackUserId}`;
}

/**
 * Email-mapping resolver (CL-3581): looks up the Slack user's account email
 * (TTL-cached per tenant+user so a busy channel does not call `users.info` on
 * every message) and matches it — case-insensitively — against the tenant's
 * Workbench member emails. Never guesses: an absent or unmatched email
 * resolves to null, and the caller is expected to drop the event at debug
 * level.
 */
export function createEmailMemberResolver(deps: {
  listMembers: () => Promise<InboxIntakeMember[]>;
  lookupEmail: SlackUserEmailLookup;
}): SlackMemberResolver {
  const cache = new Map<string, CacheEntry>();

  async function resolveEmail(
    tenantId: string,
    slackUserId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const key = cacheKey(tenantId, slackUserId);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.email;
    }
    const email = await deps.lookupEmail(tenantId, slackUserId, signal);
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { email, expiresAt: Date.now() + CACHE_TTL_MS });
    return email;
  }

  return {
    async resolveMember(tenantId, slackUserId, signal) {
      const email = await resolveEmail(tenantId, slackUserId, signal);
      if (!email) {
        log.debug("slack-member-mapping: slack user has no email on file", {
          tenantId,
          slackUserId,
        });
        return null;
      }
      const normalized = email.trim().toLowerCase();
      const members = await deps.listMembers();
      const member = members.find(
        (m) =>
          m.tenantId === tenantId &&
          m.email?.trim().toLowerCase() === normalized,
      );
      if (!member) {
        log.debug(
          "slack-member-mapping: no member matches the slack user's email",
          { tenantId, slackUserId },
        );
        return null;
      }
      return member;
    },
  };
}

/**
 * Tries each resolver in order, returning the first match. Lets a future
 * per-user OIDC-based resolver be composed in FRONT of the email resolver
 * (`composeMemberResolvers(oidcResolver, emailResolver)`) without the webhook
 * route or the email resolver itself changing.
 */
export function composeMemberResolvers(
  ...resolvers: SlackMemberResolver[]
): SlackMemberResolver {
  return {
    async resolveMember(tenantId, slackUserId, signal) {
      for (const resolver of resolvers) {
        const member = await resolver.resolveMember(
          tenantId,
          slackUserId,
          signal,
        );
        if (member) return member;
      }
      return null;
    },
  };
}

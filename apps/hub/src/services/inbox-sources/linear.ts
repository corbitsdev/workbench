import { getLogger } from "@intx/log";
import { LINEAR_SCOPE_PREFERENCE_KEY } from "@workbench/shared";
import { fetchLinearGraphQL } from "@workbench/tools-linear";
import { type } from "arktype";
import type { InboxSourceFetcher, IntakeItem } from "../inbox-source-registry";
import type { MemberToolCredential } from "../../lib/member-tool-credential";

/** `inboxSource:linear:scope` ("assigned" default | "all", CL-3580). "all"
 * broadens assigned-issue/comment queries with an `or` against `subscribers`
 * — Linear's `IssueFilter`/`CommentFilter` support `subscribers: UserFilter`
 * alongside `assignee`, so this is a genuine schema-supported OR, not an
 * invented field. Tenant-key path broadens the same way by subscriber email;
 * Linear's `UserFilter` supports `email` there too, so both credential paths
 * express "all" identically (only `isMe` vs `email` differs, matching the
 * existing assigned-issue split). */
function isAllScope(preferences?: Readonly<Record<string, unknown>>): boolean {
  return preferences?.[LINEAR_SCOPE_PREFERENCE_KEY] === "all";
}

const log = getLogger(["services", "inbox-sources", "linear"]);

/**
 * CL-3580: per-member Linear sync. Replaces the CL-3577-era "workspace-wide
 * issues created in last 24h" fetcher with viewer-scoped queries — inbox
 * notifications, issues assigned to the viewer, and updates (state changes +
 * new comments) on those issues — merged into one delivery batch.
 *
 * The `viewer` field only resolves meaningfully for a real Linear identity,
 * which we only have when the member connected their own OAuth token
 * (`cred.source === "member"`, see `resolveMemberOrTenantToolCredential`). For
 * a tenant-shared API key there is no `viewer` to scope to, but we DO know the
 * member's account email, so the tenant-key path filters
 * `assignee: { email: { eq: $email } }` on top-level `issues`/`comments`
 * queries instead — the same assigned-issue + comment coverage, minus
 * notifications (which are inherently viewer-scoped by Linear's API design and
 * have no email-filterable equivalent; they are skipped legibly with a log).
 * A tenant-key credential with no member email to scope to is skipped whole.
 *
 * Both paths emit the SAME `externalId` scheme (`issue:<id>:<updatedAtSec>`,
 * `comment:<id>`, `notification:<id>`) so switching a member between a tenant
 * key and their own OAuth token never double-delivers, and so a Linear webhook
 * (CL-3585) delivering the same activity collapses to one row via the shared
 * messageKey.
 */

const IssueRefSchema = type({
  id: "string",
  identifier: "string",
  title: "string",
  url: "string",
});

const NotificationNodeSchema = type({
  id: "string",
  createdAt: "string",
  "type?": "string | null",
  "issue?": IssueRefSchema.or("null"),
});

const ViewerNotificationsResponseSchema = type({
  viewer: {
    notifications: {
      nodes: NotificationNodeSchema.array(),
    },
  },
});

const AssignedIssueNodeSchema = type({
  id: "string",
  identifier: "string",
  title: "string",
  url: "string",
  createdAt: "string",
  updatedAt: "string",
  "state?": type({ name: "string" }).or("null"),
});

const ViewerAssignedIssuesResponseSchema = type({
  viewer: {
    assignedIssues: {
      nodes: AssignedIssueNodeSchema.array(),
    },
  },
});

const CommentNodeSchema = type({
  id: "string",
  createdAt: "string",
  body: "string",
  "issue?": IssueRefSchema.or("null"),
});

const ViewerAssignedCommentsResponseSchema = type({
  viewer: {
    assignedIssuesComments: {
      nodes: CommentNodeSchema.array(),
    },
  },
});

// Tenant-key (no viewer) top-level equivalents, scoped by assignee email.
const AssignedIssuesByEmailResponseSchema = type({
  issues: {
    nodes: AssignedIssueNodeSchema.array(),
  },
});

const AssignedCommentsByEmailResponseSchema = type({
  comments: {
    nodes: CommentNodeSchema.array(),
  },
});

const NOTIFICATIONS_QUERY = `query InboxIntakeNotifications($first: Int!) {
  viewer {
    notifications(first: $first, orderBy: createdAt) {
      nodes {
        id
        createdAt
        type
        ... on IssueNotification { issue { id identifier title url } }
        ... on IssueCommentNotification { issue { id identifier title url } }
      }
    }
  }
}`;

const ASSIGNED_ISSUES_QUERY = `query InboxIntakeAssignedIssues($first: Int!, $filter: IssueFilter) {
  viewer {
    assignedIssues(first: $first, filter: $filter, orderBy: updatedAt) {
      nodes { id identifier title url createdAt updatedAt state { name } }
    }
  }
}`;

const ASSIGNED_COMMENTS_QUERY = `query InboxIntakeAssignedComments($first: Int!, $filter: CommentFilter) {
  viewer {
    assignedIssuesComments: comments(first: $first, filter: $filter, orderBy: createdAt) {
      nodes { id createdAt body issue { id identifier title url } }
    }
  }
}`;

const ASSIGNED_ISSUES_BY_EMAIL_QUERY = `query InboxIntakeAssignedIssuesByEmail($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes { id identifier title url createdAt updatedAt state { name } }
  }
}`;

const ASSIGNED_COMMENTS_BY_EMAIL_QUERY = `query InboxIntakeAssignedCommentsByEmail($first: Int!, $filter: CommentFilter) {
  comments(first: $first, filter: $filter, orderBy: createdAt) {
    nodes { id createdAt body issue { id identifier title url } }
  }
}`;

/** Buckets an ISO timestamp to whole seconds so the dedupe key is stable
 * across re-fetches of the same event but changes on any genuine update. */
function timestampKey(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : iso;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  state?: { name: string } | null;
}

export interface LinearCommentNode {
  id: string;
  createdAt: string;
  body: string;
  issue?: { id: string; identifier: string; title: string; url: string } | null;
}

/**
 * Build the intake item for an assigned issue. The `externalId` is
 * `issue:<id>:<updatedAtSec>` — deliberately independent of the created-vs-
 * updated distinction: that distinction depends on the caller's lookback
 * cutoff (or, for a webhook, the event action), which must NOT leak into the
 * dedupe key, or the poller and the webhook would disagree on the key for the
 * same activity. The wording in the body still reflects new-vs-update. The key
 * is stable for an unchanged issue and advances only when Linear's `updatedAt`
 * genuinely moves.
 */
export function buildIssueIntakeItem(
  node: LinearIssueNode,
  cutoff: Date,
): IntakeItem {
  const isNew = Date.parse(node.createdAt) > cutoff.getTime();
  return {
    externalId: `issue:${node.id}:${timestampKey(node.updatedAt)}`,
    subject: `[${node.identifier}] ${node.title}`,
    body: [
      isNew
        ? `Linear issue assigned to you: ${node.identifier} ${node.title}`
        : `Linear issue update: ${node.identifier} ${node.title}`,
      "",
      `State: ${node.state?.name ?? "unknown"}`,
      `Link: ${node.url}`,
    ].join("\n"),
    url: node.url,
  };
}

/** Build the intake item for a new comment on an assigned issue. Returns null
 * when the comment carries no issue reference (nothing to link/route). */
export function buildCommentIntakeItem(
  node: LinearCommentNode,
): IntakeItem | null {
  const issue = node.issue;
  if (issue === null || issue === undefined) return null;
  return {
    externalId: `comment:${node.id}`,
    subject: `New comment on [${issue.identifier}] ${issue.title}`,
    body: [
      `New comment on ${issue.identifier} ${issue.title}:`,
      "",
      truncate(node.body, 2000),
      "",
      `Link: ${issue.url}`,
    ].join("\n"),
    url: issue.url,
  };
}

async function fetchNotifications(
  cred: MemberToolCredential,
  limit: number,
  signal: AbortSignal,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    NOTIFICATIONS_QUERY,
    { first: limit },
    signal,
  );
  const parsed = ViewerNotificationsResponseSchema(data);
  if (parsed instanceof type.errors) {
    log.warn("linear inbox source: unexpected notifications response shape", {
      error: parsed.summary,
    });
    return [];
  }
  const items: IntakeItem[] = [];
  for (const node of parsed.viewer.notifications.nodes) {
    const issue = node.issue ?? null;
    const label =
      issue !== null
        ? `[${issue.identifier}] ${issue.title}`
        : (node.type ?? "notification");
    items.push({
      externalId: `notification:${node.id}`,
      subject: `Linear notification: ${label}`,
      body: [
        `Linear notification (${node.type ?? "update"}) on ${label}`,
        issue !== null ? `Link: ${issue.url}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
      url: issue?.url ?? "",
    });
  }
  return items;
}

/** Actor-scoping issue filter fragment: `assigned` scopes to the assignee
 * alone; `all` ORs in `subscribers` (Linear's `IssueFilter.subscribers` is a
 * `UserFilter` relation filter, the same shape as `assignee`) so issues the
 * viewer merely subscribes to/is involved in also count. */
function actorIssueFilter(
  isMe: { isMe: { eq: true } } | { email: { eq: string } },
  allScope: boolean,
): Record<string, unknown> {
  if (!allScope) return { assignee: isMe };
  return { or: [{ assignee: isMe }, { subscribers: isMe }] };
}

async function fetchAssignedIssueUpdates(
  cred: MemberToolCredential,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
  allScope: boolean,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    ASSIGNED_ISSUES_QUERY,
    {
      first: limit,
      filter: {
        ...actorIssueFilter({ isMe: { eq: true } }, allScope),
        updatedAt: { gt: cutoff.toISOString() },
      },
    },
    signal,
  );
  const parsed = ViewerAssignedIssuesResponseSchema(data);
  if (parsed instanceof type.errors) {
    log.warn("linear inbox source: unexpected assigned-issues response shape", {
      error: parsed.summary,
    });
    return [];
  }
  return parsed.viewer.assignedIssues.nodes.map((node) =>
    buildIssueIntakeItem(node, cutoff),
  );
}

async function fetchAssignedIssueUpdatesByEmail(
  cred: MemberToolCredential,
  email: string,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
  allScope: boolean,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    ASSIGNED_ISSUES_BY_EMAIL_QUERY,
    {
      first: limit,
      filter: {
        ...actorIssueFilter({ email: { eq: email } }, allScope),
        updatedAt: { gt: cutoff.toISOString() },
      },
    },
    signal,
  );
  const parsed = AssignedIssuesByEmailResponseSchema(data);
  if (parsed instanceof type.errors) {
    log.warn(
      "linear inbox source: unexpected assigned-issues-by-email response shape",
      { error: parsed.summary },
    );
    return [];
  }
  return parsed.issues.nodes.map((node) => buildIssueIntakeItem(node, cutoff));
}

async function fetchAssignedIssueComments(
  cred: MemberToolCredential,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
  allScope: boolean,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    ASSIGNED_COMMENTS_QUERY,
    {
      first: limit,
      filter: {
        issue: actorIssueFilter({ isMe: { eq: true } }, allScope),
        createdAt: { gt: cutoff.toISOString() },
      },
    },
    signal,
  );
  const parsed = ViewerAssignedCommentsResponseSchema(data);
  if (parsed instanceof type.errors) {
    log.warn("linear inbox source: unexpected comments response shape", {
      error: parsed.summary,
    });
    return [];
  }
  return parsed.viewer.assignedIssuesComments.nodes
    .map((node) => buildCommentIntakeItem(node))
    .filter((item): item is IntakeItem => item !== null);
}

async function fetchAssignedIssueCommentsByEmail(
  cred: MemberToolCredential,
  email: string,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
  allScope: boolean,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    ASSIGNED_COMMENTS_BY_EMAIL_QUERY,
    {
      first: limit,
      filter: {
        issue: actorIssueFilter({ email: { eq: email } }, allScope),
        createdAt: { gt: cutoff.toISOString() },
      },
    },
    signal,
  );
  const parsed = AssignedCommentsByEmailResponseSchema(data);
  if (parsed instanceof type.errors) {
    log.warn(
      "linear inbox source: unexpected comments-by-email response shape",
      { error: parsed.summary },
    );
    return [];
  }
  return parsed.comments.nodes
    .map((node) => buildCommentIntakeItem(node))
    .filter((item): item is IntakeItem => item !== null);
}

/**
 * Merged Linear inbox fetcher. For a member OAuth token: notifications +
 * assigned-issue created/updated + new comments on assigned issues, all
 * viewer-scoped. For a tenant-shared key: the same assigned-issue + comment
 * coverage scoped by the member's account email, minus notifications (no
 * viewer, no email-filterable equivalent). Each sub-fetch emits a dedupe-stable
 * `externalId` (`notification:`, `issue:<id>:<updatedAtSec>`, `comment:`) so a
 * genuinely new event gets its own mailbox row via `deliverItems`'s
 * `inbox:linear:<externalId>` messageKey, while re-fetching the same unchanged
 * activity across overlapping ticks — or across a credential-type switch, or a
 * webhook + a poll of the same activity — never re-delivers.
 */
export const fetchLinearInboxItems: InboxSourceFetcher = async (
  cred,
  cutoff,
  limit,
  signal,
  memberEmail,
  memberPreferences,
) => {
  const allScope = isAllScope(memberPreferences);
  if (cred.source === "member") {
    const [notifications, assignedIssues, comments] = await Promise.all([
      fetchNotifications(cred, limit, signal),
      fetchAssignedIssueUpdates(cred, cutoff, limit, signal, allScope),
      fetchAssignedIssueComments(cred, cutoff, limit, signal, allScope),
    ]);
    return [...notifications, ...assignedIssues, ...comments];
  }

  // Tenant-shared key: no `viewer` identity, but the member's email scopes the
  // assignee filter. Notifications are inherently viewer-scoped and skipped.
  const email = memberEmail?.trim();
  if (!email) {
    log.info(
      "linear inbox source: tenant key with no member email to scope; skipping",
      { source: cred.source },
    );
    return [];
  }
  log.info(
    "linear inbox source: tenant key; scoping by assignee email (notifications skipped — viewer-only)",
    { source: cred.source },
  );
  const [assignedIssues, comments] = await Promise.all([
    fetchAssignedIssueUpdatesByEmail(
      cred,
      email,
      cutoff,
      limit,
      signal,
      allScope,
    ),
    fetchAssignedIssueCommentsByEmail(
      cred,
      email,
      cutoff,
      limit,
      signal,
      allScope,
    ),
  ]);
  return [...assignedIssues, ...comments];
};

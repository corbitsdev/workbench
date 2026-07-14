import { getLogger } from "@intx/log";
import { fetchLinearGraphQL } from "@workbench/tools-linear";
import { type } from "arktype";
import type { InboxSourceFetcher, IntakeItem } from "../inbox-source-registry";
import type { MemberToolCredential } from "../../lib/member-tool-credential";

const log = getLogger(["services", "inbox-sources", "linear"]);

/**
 * CL-3580: per-member Linear sync. Replaces the CL-3577-era "workspace-wide
 * issues created in last 24h" fetcher with three viewer-scoped queries —
 * inbox notifications, issues assigned to the viewer, and updates (state
 * changes + new comments) on those issues — merged into one delivery batch.
 *
 * The `viewer` field only resolves meaningfully for a real Linear identity,
 * which we only have when the member connected their own OAuth token
 * (`cred.source === "member"`, see `resolveMemberOrTenantToolCredential`). A
 * tenant-shared API key has no member identity to scope `viewer` to, and
 * `InboxIntakeMember` carries no email to filter by — rather than guess (e.g.
 * assignee-name matching against a display name), the tenant-key case is
 * skipped legibly with a log line. Once a per-member email becomes available
 * to this source, the tenant-key path can filter `assignee: { email: { eq } }`
 * instead of `assignee: { isMe: { eq: true } }`.
 *
 * Linear webhooks would be the better long-term transport for OAuth-connected
 * workspaces (push instead of a 60s poll, and true created/updated/comment
 * event granularity) but are out of scope here — they need a public callback
 * endpoint, per-workspace webhook registration/rotation, and signature
 * verification, none of which exist yet. Polling is the correct fit for this
 * ticket; webhook infra is a follow-up if 60s latency becomes a problem.
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

/** Buckets an ISO timestamp to whole seconds so the dedupe key is stable
 * across re-fetches of the same event but changes on any genuine update. */
function timestampKey(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : iso;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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

async function fetchAssignedIssueUpdates(
  cred: MemberToolCredential,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    ASSIGNED_ISSUES_QUERY,
    {
      first: limit,
      filter: {
        assignee: { isMe: { eq: true } },
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
  const items: IntakeItem[] = [];
  for (const node of parsed.viewer.assignedIssues.nodes) {
    const isNew = Date.parse(node.createdAt) > cutoff.getTime();
    const kind = isNew ? "created" : "updated";
    items.push({
      externalId: `issue:${node.id}:${kind}:${timestampKey(node.updatedAt)}`,
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
    });
  }
  return items;
}

async function fetchAssignedIssueComments(
  cred: MemberToolCredential,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
): Promise<IntakeItem[]> {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    ASSIGNED_COMMENTS_QUERY,
    {
      first: limit,
      filter: {
        issue: { assignee: { isMe: { eq: true } } },
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
  const items: IntakeItem[] = [];
  for (const node of parsed.viewer.assignedIssuesComments.nodes) {
    const issue = node.issue;
    if (issue === null || issue === undefined) continue;
    items.push({
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
    });
  }
  return items;
}

/**
 * Merged Linear inbox fetcher: notifications + assigned-issue created/updated
 * + new comments on assigned issues, all viewer-scoped. Each sub-fetch uses a
 * dedupe-stable `externalId` prefix (`notification:`, `issue:`, `comment:`)
 * so a genuinely new event always gets its own mailbox row via
 * `deliverItems`'s `inbox:linear:<externalId>` messageKey, while re-fetching
 * the same unchanged issue/notification across ticks (the lookback window
 * overlaps by design) never re-delivers: the issue key embeds `updatedAt`
 * (bucketed to the second) so it is stable for an unchanged issue and changes
 * only when Linear's `updatedAt` genuinely advances; notification and comment
 * ids are already unique per event from Linear.
 */
export const fetchLinearInboxItems: InboxSourceFetcher = async (
  cred,
  cutoff,
  limit,
  signal,
) => {
  if (cred.source !== "member") {
    log.info(
      "linear inbox source: no member OAuth identity for viewer-scoped sync; skipping",
      { source: cred.source },
    );
    return [];
  }

  const [notifications, assignedIssues, comments] = await Promise.all([
    fetchNotifications(cred, limit, signal),
    fetchAssignedIssueUpdates(cred, cutoff, limit, signal),
    fetchAssignedIssueComments(cred, cutoff, limit, signal),
  ]);

  return [...notifications, ...assignedIssues, ...comments];
};

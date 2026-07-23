/**
 * Maintained copy describing each primary workbench route for Myra session
 * launch. Strings are product-facing summaries only — no user data, secrets,
 * or live HTML.
 */
export type PageContextEntry = {
  /** Stable id for docs/tests */
  id: string;
  /** Returns true when this entry applies to the pathname (no query string). */
  match: (pathname: string) => boolean;
  context: string;
};

function segmentPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function matchPrefix(pathname: string, prefix: string): boolean {
  const base = prefix.replace(/\/+$/, "") || "/";
  if (pathname === base) return true;
  return pathname.startsWith(`${base}/`);
}

export const PAGE_CONTEXT_CATALOG: readonly PageContextEntry[] = [
  {
    id: "inbox",
    match: (p) => p === "/" || matchPrefix(p, "/inbox"),
    context:
      "Inbox home: a living dashboard with a Now feed of recent activity, triage-oriented message list, and shortcuts into deeper work. Users read and act on inbound items, mark read/unread, and open threads. Artifacts and workflows linked from items open in their own surfaces.",
  },
  {
    id: "chats-list",
    match: (p) => p === "/chats",
    context:
      "Myra threads list: every personal chat thread with Myra for this workbench. Users pick a thread, start a new conversation, or switch context between topics. Each thread is an isolated agent instance with its own transcript.",
  },
  {
    id: "chat-thread",
    match: (p) => matchPrefix(p, "/chats/") && p !== "/chats",
    context:
      "Full-page Myra chat for one thread: the main conversation surface with transcript, composer, attachments, workflow gate cards, and action requests. The user is focused on a single ongoing dialogue with Myra.",
  },
  {
    id: "artifacts-list",
    match: (p) => p === "/artifacts",
    context:
      "Artifacts library: versioned documents and files the team shares. Users browse, search, filter, and open artifacts. Saving creates new versions; artifacts can be handed to Myra by id from other surfaces.",
  },
  {
    id: "artifact-detail",
    match: (p) => matchPrefix(p, "/artifacts/") && p !== "/artifacts",
    context:
      "Artifact detail: one shared document or file with version history, preview, and actions such as open in Myra or copy links. The user is editing or reviewing a specific artifact, not the whole library.",
  },
  {
    id: "workflows",
    match: (p) => matchPrefix(p, "/workflows"),
    context:
      "Workflows: deployed runnable procedures for the workbench. Users browse workflow kinds, start runs, inspect status, and open run traces. Pending human gates may need signals from chat or run controls.",
  },
  {
    id: "settings",
    match: (p) =>
      p === "/settings" ||
      p === "/settings/connections" ||
      matchPrefix(p, "/settings/tools/"),
    context:
      "Settings: workbench configuration for the signed-in member — profile, connected integrations, tool credentials, and per-tool setup. Changes here affect what agents can access, not org-wide admin definitions.",
  },
  {
    id: "skills-library",
    match: (p) => p === "/skills",
    context:
      "Skills library: approved reusable procedures Myra and other agents can load. Users browse published skills and open one to read or refine. Pending drafts live under Skills → Pending drafts after Myra drafts a skill.",
  },
  {
    id: "skills-new",
    match: (p) => p === "/skills/new",
    context:
      "Create skill: authoring flow for a new reusable procedure before it enters the pending-drafts queue. The user is writing skill instructions and metadata for later approval into the library.",
  },
  {
    id: "skill-detail",
    match: (p) => {
      const parts = segmentPath(p);
      return parts[0] === "skills" && parts.length === 2 && parts[1] !== "new";
    },
    context:
      "Skill detail: one published or draft skill with its procedure text and metadata. Users review how agents should run this play and may edit if they have access.",
  },
  {
    id: "agents-list",
    match: (p) => p === "/agents",
    context:
      "Agents: read-only list of the agent instances this member has deployed — name, description, status, and mail address. Creating or editing agents is not yet available from this page.",
  },
  {
    id: "admin-tool-detail",
    match: (p) => {
      const parts = segmentPath(p);
      return (
        parts[0] === "settings" &&
        parts[1] === "admin" &&
        parts[2] === "tools" &&
        parts.length === 4
      );
    },
    context:
      "Admin tool detail: one loadable tool package — manifest, grants, credential requirements, and how agents invoke it. Tenant admins tune or inspect this integration, not member Settings tool setup.",
  },
  {
    id: "admin-tools",
    match: (p) => p === "/settings/admin/tools",
    context:
      "Admin tools catalog (tenant admin): loadable tool packages and capabilities exposed to agents in this workbench. Admins browse definitions and open a tool for manifest and grant details — not end-user chat.",
  },
  {
    id: "admin-principal-detail",
    match: (p) => {
      const parts = segmentPath(p);
      return (
        parts[0] === "settings" &&
        parts[1] === "admin" &&
        parts[2] === "principals" &&
        parts.length === 4
      );
    },
    context:
      "Admin principal detail: one member, agent, or service identity with grants, group membership, and linked resources. Used for access debugging and governance review.",
  },
  {
    id: "admin-definition-detail",
    match: (p) => {
      const parts = segmentPath(p);
      return (
        parts[0] === "settings" &&
        parts[1] === "admin" &&
        parts[2] === "definitions" &&
        parts.length === 4
      );
    },
    context:
      "Admin agent definition detail: one template's metadata, default tools, prompts, and deployment notes. Admins compare versions before members deploy instances from this definition.",
  },
  {
    id: "admin-principals",
    match: (p) => p === "/settings/admin/principals",
    context:
      "Admin principals: members, agents, and service principals in the tenant. Admins browse identities and open one for grants and membership — access debugging, not day-to-day operator work.",
  },
  {
    id: "admin-definitions",
    match: (p) => p === "/settings/admin/definitions",
    context:
      "Admin agent definitions: seeded and custom agent templates for the tenant. Admins browse templates and open one for metadata, tools, and prompts.",
  },
  {
    id: "admin-hub",
    match: (p) => p === "/settings/admin" || p === "/settings/admin/",
    context:
      "Admin home: tenant governance entry point redirecting into principals, definitions, tools, and audit. The user is in tenant-admin mode, not the member operator shell.",
  },
  {
    id: "admin-audit",
    match: (p) => p === "/settings/admin/audit",
    context:
      "Admin audit log: security- and ops-relevant events for the tenant. Admins filter and inspect who did what — not a product analytics dashboard.",
  },
  {
    id: "owner-hub",
    match: (p) => p === "/settings/owner" || p === "/settings/owner/",
    context:
      "Owner home: platform-operator entry for catalog, capabilities, workflows, and demos. Distinct from tenant member routes and tenant admin.",
  },
  {
    id: "owner-catalog",
    match: (p) => p === "/settings/owner/catalog",
    context:
      "Owner catalog: platform-level models, templates, and shared assets operators curate across workbenches. Owner-role surface for global configuration, not tenant member settings.",
  },
  {
    id: "owner-capabilities-gamma",
    match: (p) => p === "/settings/owner/capabilities/gamma",
    context:
      "Owner gamma templates: experimental capability templates before wider rollout. Owners edit and publish gamma definitions used when provisioning advanced agent features.",
  },
  {
    id: "owner-capabilities",
    match: (p) => matchPrefix(p, "/settings/owner/capabilities"),
    context:
      "Owner capabilities: platform capability packs and how they map to agent features. Owners enable or tune cross-tenant building blocks.",
  },
  {
    id: "owner-workflows",
    match: (p) => p === "/settings/owner/workflows",
    context:
      "Owner workflows: platform workflow definitions and deployment patterns operators maintain. Distinct from the member-facing /workflows run surface.",
  },
  {
    id: "owner-demos",
    match: (p) => p === "/settings/owner/demos",
    context:
      "Owner demos: curated demonstration flows for sales or onboarding. Owners configure scripted experiences, not production tenant data.",
  },
  {
    id: "insights-overview",
    match: (p) => p === "/insights",
    context:
      "Insights overview: usage and health KPIs for the workbench — engagement, inference volume, and cost-oriented summaries. Operators explore trends and drill into people or runs.",
  },
  {
    id: "insights-runs",
    match: (p) => p === "/insights/runs",
    context:
      "Workflow run history: searchable list of workflow executions with status, timing, and links to traces. Used to debug failures and audit routine runs.",
  },
  {
    id: "insights-actor",
    match: (p) => matchPrefix(p, "/insights/users/"),
    context:
      "Person activity in Insights: one member's agent usage, sessions, and workflow participation over a selected time range. Supports coaching and cost attribution, not inbox triage.",
  },
  {
    id: "insights-trace",
    match: (p) => matchPrefix(p, "/insights/trace/"),
    context:
      "Workflow trace: step-by-step timeline for a single workflow run — inputs, tool calls, gates, and outcomes. The user is debugging or reviewing one execution in detail.",
  },
];

/** Generic fallback when the shell is open on a route without a dedicated entry. */
export const PAGE_CONTEXT_FALLBACK =
  "Workbench: the signed-in member's Corbits workspace with inbox, Myra chat, artifacts, workflows, skills, and settings. Help using the feature that matches what they describe.";

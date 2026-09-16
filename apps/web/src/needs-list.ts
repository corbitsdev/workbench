import { WorkflowDefinitionSource } from "@intx/types/workflow-sources";
import { type } from "arktype";

const ManifestVersion = type("number").narrow(
  (version, ctx) => version === 1 || ctx.mustBe("manifest version 1"),
);

export const WorkflowDeployInputSchema = type({
  source: WorkflowDefinitionSource,
  entry: "string > 0",
  sourceOfferingIds: type("string > 0").array().atLeastLength(1),
  defaultSourceOfferingId: "string > 0",
  "pin?": "string > 0",
});
export type WorkflowDeployInput = typeof WorkflowDeployInputSchema.infer;

const DesiredPrincipalSchema = type({
  kind: "'user' | 'workflow'",
  refId: "string > 0",
  "email?": "string > 0",
  status: "'active'",
  roles: "string[]",
});

export const NeedsListSchema = type({
  version: ManifestVersion,
  account: {
    id: "string > 0",
    name: "string > 0",
    email: "string > 0",
  },
  primaryTenant: {
    kind: "'primary'",
    want: "'existing'",
  },
  myra: {
    definitionRefId: "string > 0",
    scope: "'top-level'",
    want: "'running'",
    "deploy?": WorkflowDeployInputSchema,
  },
  workbenches: type({
    localId: "string > 0",
    slug: "string > 0",
    name: "string > 0",
    kind: "'workbench'",
    parent: "'primary'",
    principals: DesiredPrincipalSchema.array(),
    "initialMessage?": type({
      runId: "string > 0",
      content: "string > 0",
    }),
  }).array(),
});
export type NeedsList = typeof NeedsListSchema.infer;

export type NeedsListInput = {
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
  readonly myraDefinitionRefId: string;
  readonly myraDeploy?: WorkflowDeployInput;
  readonly workbenches?: readonly {
    readonly localId: string;
    readonly slug: string;
    readonly name: string;
    readonly principals?: readonly {
      readonly kind: "user" | "workflow";
      readonly refId: string;
      readonly email?: string;
      readonly roles: readonly string[];
    }[];
    /** Caller-supplied primary-thread first message for the child tenant:
     * the run to address and the exact content to send. Never synthesized. */
    readonly initialMessage?: {
      readonly runId: string;
      readonly content: string;
    };
  }[];
};

export function buildNeedsList(input: NeedsListInput): NeedsList {
  return {
    version: 1,
    account: { ...input.account },
    primaryTenant: { kind: "primary", want: "existing" },
    myra: {
      definitionRefId: input.myraDefinitionRefId,
      scope: "top-level",
      want: "running",
      ...(input.myraDeploy === undefined ? {} : { deploy: input.myraDeploy }),
    },
    workbenches: (input.workbenches ?? []).map((workbench) => ({
      localId: workbench.localId,
      slug: workbench.slug,
      name: workbench.name,
      kind: "workbench" as const,
      parent: "primary" as const,
      principals: (workbench.principals ?? []).map((principal) => ({
        kind: principal.kind,
        refId: principal.refId,
        ...(principal.email === undefined ? {} : { email: principal.email }),
        status: "active" as const,
        roles: [...principal.roles],
      })),
      ...(workbench.initialMessage === undefined
        ? {}
        : {
            initialMessage: {
              runId: workbench.initialMessage.runId,
              content: workbench.initialMessage.content,
            },
          }),
    })),
  };
}

export function parseNeedsList(data: unknown) {
  return NeedsListSchema(data);
}

export type StringStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const ChildTenantRecordSchema = type({
  localId: "string > 0",
  tenantId: "string > 0",
  kind: "'workbench'",
  // The workbench's primary thread: the native Message-ID of the first
  // conversation.message sent in the child tenant. Recorded beside the
  // created id so a retry never resends — idempotency rides this id.
  // Workbench metadata beyond Subject/List-ID (icon, prefs) lives here
  // too: client-held, never a server table.
  "primaryThreadMessageId?": "string > 0",
  "icon?": "string > 0",
  "prefs?": "Record<string, unknown>",
});
export type ChildTenantRecord = typeof ChildTenantRecordSchema.infer;

export type ChildTenantStore = {
  load(): ChildTenantRecord[];
  record(record: ChildTenantRecord): void;
};

export function childTenantStore(
  storage: StringStorage,
  hubScope: string,
  accountId: string,
): ChildTenantStore {
  const key = `workbench.child-tenants:${encodeURIComponent(hubScope)}:${encodeURIComponent(accountId)}`;
  const load = (): ChildTenantRecord[] => {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      // One bad row must not discard every tracked id — validate per row
      // and keep the rows that parse, so a single corrupt entry only loses
      // itself.
      if (!Array.isArray(parsed)) return [];
      const rows: ChildTenantRecord[] = [];
      for (const row of parsed) {
        const validated = ChildTenantRecordSchema(row);
        if (!(validated instanceof type.errors)) rows.push({ ...validated });
      }
      return rows;
    } catch {
      // report-error-ignore: corrupt client storage is ordinary state, not an
      // incident — an unreadable row reads as empty and is overwritten on the
      // next record, so reporting it would spam the sink on every load.
      return [];
    }
  };
  return {
    load,
    record(record) {
      const records = load().filter((row) => row.localId !== record.localId);
      records.push(record);
      storage.setItem(key, JSON.stringify(records));
    },
  };
}

const ThreadLinkSchema = type({
  workbenchLocalId: "string > 0",
  messageId: "string > 0",
  // The native fork ancestry for this sub-thread first message: the parent
  // becomes In-Reply-To and closes References. Held here until the stock
  // submission route accepts threading headers.
  "inReplyTo?": "string > 0",
  "references?": type("string > 0").array(),
  // The forked subject, so a retry of the same fork replays its recorded
  // Message-ID while a different subject off the same parent sends anew.
  "subject?": "string > 0",
});
export type ThreadLink = typeof ThreadLinkSchema.infer;

export type ThreadLinkStore = {
  load(): ThreadLink[];
  record(link: ThreadLink): void;
};

/** Client-held sub-thread fork links, scoped exactly like the child-tenant
 * store: one entry per sub-thread first message, deduped by native
 * Message-ID, corrupt rows skipped per row. */
export function threadLinkStore(
  storage: StringStorage,
  hubScope: string,
  accountId: string,
): ThreadLinkStore {
  const key = `workbench.thread-links:${encodeURIComponent(hubScope)}:${encodeURIComponent(accountId)}`;
  const load = (): ThreadLink[] => {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const rows: ThreadLink[] = [];
      for (const row of parsed) {
        const validated = ThreadLinkSchema(row);
        if (!(validated instanceof type.errors)) rows.push({ ...validated });
      }
      return rows;
    } catch {
      // report-error-ignore: corrupt client storage is ordinary state, not an
      // incident — an unreadable row reads as empty and is overwritten on the
      // next record, so reporting it would spam the sink on every load.
      return [];
    }
  };
  return {
    load,
    record(link) {
      const links = load().filter((row) => row.messageId !== link.messageId);
      links.push(link);
      storage.setItem(key, JSON.stringify(links));
    },
  };
}

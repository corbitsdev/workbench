import { WorkflowDefinitionSource } from "@intx/types/workflow-sources";
import { type } from "arktype";

export const WorkflowDeployInputSchema = type({
  source: WorkflowDefinitionSource,
  entry: "string > 0",
  sourceOfferingIds: type("string > 0").array().atLeastLength(1),
  defaultSourceOfferingId: "string > 0",
  "pin?": "string > 0",
});
export type WorkflowDeployInput = typeof WorkflowDeployInputSchema.infer;

export type StringStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const ChildTenantRecordSchema = type({
  localId: "string > 0",
  tenantId: "string > 0",
  kind: "'workbench'",
  // Recorded so a retry never resends — idempotency rides this id.
  // Workbench metadata beyond Subject/List-ID lives here too, client-held.
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
  // A retry of the same fork replays its recorded Message-ID; a different
  // subject/recipients/body off the same parent sends anew.
  "subject?": "string > 0",
  "to?": type("string").array(),
  "body?": "string",
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

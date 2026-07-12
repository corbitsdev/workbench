import type { TaskAdapter } from "./adapter";
import { createAttioTaskAdapter } from "./attio-adapter";
import { createLinearTaskAdapter } from "./linear-adapter";

// The v1 adapter registry — a static, hand-merged, name-keyed map mirroring the
// hub tool-registry house pattern. Adding a downstream system is a
// registration here plus its credential-catalog line, never a core change.
export const TASK_ADAPTERS: Record<string, TaskAdapter> = {
  attio: createAttioTaskAdapter({ fetcher: fetch }),
  linear: createLinearTaskAdapter({ fetcher: fetch }),
};

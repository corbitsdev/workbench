// The seam a notification sink plugs into, shaped exactly like
// `@corbits/commands`' command-plugin contract: a set of named factory
// exports, a registry that holds plugins by name, and an explicit
// registration call in the host's composition root. There is no dispatch
// table and no switch — adding Slack, email or anything else is one
// package plus one `register(...)` line, and nothing in this file changes.
import type { NotificationEvent } from "./events";

export type SinkScope = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type SinkDeliveryContext = {
  readonly tenantId: string;
  readonly principalId: string;
  /** The durable mail row this delivery is a fan-out of; the mail is the record, the sink is a copy. */
  readonly mailboxRowId: string;
  readonly event: NotificationEvent;
};

export type SinkDeliveryResult =
  | { readonly status: "delivered" }
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly retryable: boolean;
    };

export type NotificationSinkPlugin = {
  readonly name: string;
  isEnabledFor(scope: SinkScope): Promise<boolean>;
  deliver(ctx: SinkDeliveryContext): Promise<SinkDeliveryResult>;
};

export type SinkRegistry = {
  register(plugin: NotificationSinkPlugin): void;
  get(name: string): NotificationSinkPlugin | undefined;
  list(): readonly NotificationSinkPlugin[];
  listEnabledFor(scope: SinkScope): Promise<readonly NotificationSinkPlugin[]>;
};

export class DuplicateSinkNameError extends Error {
  constructor(name: string) {
    super(
      `A notification sink named ${JSON.stringify(name)} is already registered; ` +
        "each sink owns its name outright so a delivery row can always name one plugin.",
    );
    this.name = "DuplicateSinkNameError";
  }
}

export function createSinkRegistry(): SinkRegistry {
  const plugins = new Map<string, NotificationSinkPlugin>();
  return {
    register(plugin) {
      if (plugins.has(plugin.name))
        throw new DuplicateSinkNameError(plugin.name);
      plugins.set(plugin.name, plugin);
    },
    get(name) {
      return plugins.get(name);
    },
    list() {
      return [...plugins.values()];
    },
    async listEnabledFor(scope) {
      const enabled: NotificationSinkPlugin[] = [];
      for (const plugin of plugins.values()) {
        if (await plugin.isEnabledFor(scope)) enabled.push(plugin);
      }
      return enabled;
    },
  };
}

// The command registry: a name -> `CommandDefinition` lookup any host
// surface (a workbench's message pipeline, an autocomplete listing, a
// direct execute endpoint) dispatches through. Sized to what workbench
// needs today — `CommandResult` is a closed, small union, never the
// TUI-shaped result types (`view`, `overlay`, `modal`, `paste-image`,
// ...) corbits-code's own registry carries.
//
// Registration happens two ways: `registerCommand` for a fixed,
// process-lifetime command (a bare "/help", say), and
// `registerCommandPlugin` for a set that can only be known per tenant
// — the seeded-workflow registrar in `./workflow-commands` is the
// motivating case, since a bench's available workflows are runtime
// data, not a boot-time constant. A plugin's commands are folded in
// beside the static ones every time the registry is asked to list or
// resolve, indistinguishable from a built-in from the caller's side.

export type CommandResult =
  | { readonly type: "message"; readonly text: string }
  | {
      readonly type: "workflow-started";
      readonly definitionId: string;
      readonly address: string;
      /** The workbench-facing handle the started workflow now answers
       * to (its participant handle), for a result message to name. */
      readonly handle: string;
    }
  | { readonly type: "noop" };

export interface CommandContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
}

export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  /** Shown in autocomplete once a name is fully typed, e.g. "[input]". */
  readonly argumentHint?: string;
  /** Registered but never listed or offered by name-prefix completion
   * — still resolvable and dispatchable directly. Defaults to false. */
  readonly hidden?: boolean;
  readonly handler: (
    args: string,
    ctx: CommandContext,
  ) => Promise<CommandResult> | CommandResult;
}

/** The autocomplete-facing projection of a command: no handler, since
 * a dropdown never calls one — see the package doc comment on why this
 * package stays UI-free. */
export type CommandListing = Pick<
  CommandDefinition,
  "name" | "description" | "argumentHint"
>;

export type CommandPlugin = (ctx: {
  readonly tenantId: string;
}) => Promise<readonly CommandDefinition[]>;

export interface CommandRegistry {
  registerCommand(definition: CommandDefinition): void;
  registerCommandPlugin(plugin: CommandPlugin): void;
  /** Every non-hidden command available to `tenantId`, sorted by name. */
  listCommands(tenantId: string): Promise<readonly CommandDefinition[]>;
  /** A command by name, hidden or not, available to `tenantId`. */
  getCommand(
    name: string,
    tenantId: string,
  ): Promise<CommandDefinition | undefined>;
}

export function createCommandRegistry(): CommandRegistry {
  const staticCommands = new Map<string, CommandDefinition>();
  const plugins: CommandPlugin[] = [];

  function registerCommand(definition: CommandDefinition): void {
    if (staticCommands.has(definition.name)) {
      throw new Error(`command "${definition.name}" is already registered`);
    }
    staticCommands.set(definition.name, definition);
  }

  function registerCommandPlugin(plugin: CommandPlugin): void {
    plugins.push(plugin);
  }

  // Static commands win a name collision against a plugin's, matching
  // corbits-code's "builtins first" precedent — a plugin's commands are
  // additive, never able to shadow a fixed one.
  async function resolveAll(tenantId: string): Promise<CommandDefinition[]> {
    const merged = new Map<string, CommandDefinition>();
    for (const plugin of plugins) {
      for (const definition of await plugin({ tenantId })) {
        merged.set(definition.name, definition);
      }
    }
    for (const definition of staticCommands.values()) {
      merged.set(definition.name, definition);
    }
    return [...merged.values()];
  }

  return {
    registerCommand,
    registerCommandPlugin,
    async listCommands(tenantId) {
      const all = await resolveAll(tenantId);
      return all
        .filter((definition) => definition.hidden !== true)
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async getCommand(name, tenantId) {
      const all = await resolveAll(tenantId);
      return all.find((definition) => definition.name === name);
    },
  };
}

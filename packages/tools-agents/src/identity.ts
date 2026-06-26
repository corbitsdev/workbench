import type { ToolDefinition } from "@intx/types/runtime";

// Per-tool account identity for the person you work for (CL-2420). Hub-backed:
// definitions live here, execution is hub-side against the member_identity
// table. Identity is looked up on demand — never dumped into the prompt.

export const IDENTITY_GET_DEFINITION: ToolDefinition = {
  name: "identity_get",
  description:
    "Look up the account identity of the person you work for, for scoping 'my …' queries to a tool (e.g. their Linear user id, calendar email, Attio actor). Pass the provider names you need (e.g. ['linear'], or ['linear','attio'] to get both in one call) and you get the full accounts — value, label, whether it is primary, and metadata. Call with no providers to get a compact index of which providers have accounts and their labels, then fetch the ones you need. A person may have several accounts for one provider; prefer the primary unless they name another. Look up only the providers the task touches.",
  inputSchema: {
    type: "object",
    properties: {
      providers: {
        type: "array",
        items: { type: "string" },
        description:
          "Provider names to return full accounts for (e.g. 'linear', 'attio', 'granola'). Omit for a compact index of all providers.",
      },
    },
    required: [],
  },
};

export const IDENTITY_SET_DEFINITION: ToolDefinition = {
  name: "identity_set",
  description:
    "Store (or update) one account identity for the person you work for, so it can scope their queries later. Use this after resolving an identifier once — for example, looking up their Linear user by their known email — so you never have to resolve it again. Keyed by provider + value; pass a label for a human name when they have several accounts of the same tool, set primary to make it the default for that provider, and metadata for anything else worth keeping (workspace name, associated email).",
  inputSchema: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        description: "The tool/provider, e.g. 'linear', 'attio', 'granola'.",
      },
      value: {
        type: "string",
        description:
          "The identifier this tool uses for the person (e.g. a Linear user id, an actor id, or an email).",
      },
      label: {
        type: "string",
        description:
          "Optional human name for this account when the provider has several (e.g. 'Work', 'Personal').",
      },
      primary: {
        type: "boolean",
        description:
          "Make this the default account for the provider. Clears the prior primary for that provider.",
      },
      metadata: {
        type: "object",
        description:
          "Optional extra facts about the account (workspace name, associated email, …).",
      },
    },
    required: ["provider", "value"],
  },
};

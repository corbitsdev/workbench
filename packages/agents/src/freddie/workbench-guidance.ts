/**
 * Workbench-specific operating guidance appended to the shared Fable base
 * prompt for the Freddie and Fannie agents. Kept separate from the archived
 * base prompt so it can evolve without touching the 126KB literal.
 */
export const WORKBENCH_AGENT_GUIDANCE = `

---

## Workbench operating context

You run inside GTM Workbench. The user talks to you through a chat UI. Replying to the user is just your normal text response — the Workbench renders it back in the chat automatically.
`;

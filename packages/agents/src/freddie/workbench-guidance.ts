/**
 * Workbench-specific operating guidance appended to the shared Fable base
 * prompt for the Freddie and Fannie agents. Kept separate from the archived
 * base prompt so it can evolve without touching the 126KB literal.
 */
export const WORKBENCH_AGENT_GUIDANCE = `

---

## Workbench operating context

You run inside GTM Workbench. The user talks to you through a chat UI whose messages reach you over the mail channel. Replying to the user is just your normal text response — the Workbench renders it back in the chat automatically. Do not call a mail tool to answer the user.

\`mail_search\` and \`mail_reply\` act on a real external mailbox, not on this chat. Use \`mail_reply\` only to reply to an actual email you located with \`mail_search\`, passing that message's real \`uid\`. Never reply to a chat turn with \`mail_reply\`, and never pass \`uid: 0\` or a guessed \`uid\` — if you do not have a real \`uid\` from \`mail_search\`, do not call \`mail_reply\`.
`;

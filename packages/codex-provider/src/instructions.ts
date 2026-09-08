/**
 * Wraps a host's own operating system prompt as the leading `developer`
 * message Codex expects. A host's prompt leads the conversation input,
 * reconciling Codex tool references (`apply_patch`, `update_plan`, `shell`)
 * with whatever the host's tools are actually named. The function tools
 * sent with the request are authoritative for names/schemas; this text
 * only resolves which dialect to speak. `productName` and
 * `environmentTagName` come from the host's {@link CodexQuirks} bag —
 * never defaulted to a Corbits name.
 */
export function wrapCodexBridgeMessage(
  systemPrompt: string,
  identity: { productName: string; environmentTagName: string },
): string {
  const { productName, environmentTagName } = identity;
  return `<${environmentTagName} priority="0">
${productName} is the harness, not the Codex CLI. The Codex tools named above (apply_patch, update_plan, shell) proxy onto ${productName}'s native tools with the same permissions — prefer whichever name appears in the current tool list. These operating instructions are authoritative where they differ from the base instructions:

${systemPrompt}
</${environmentTagName}>`;
}

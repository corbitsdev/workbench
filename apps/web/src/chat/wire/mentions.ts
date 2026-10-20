// Humans (`prn_…`) read the workbench timeline directly and are never
// fanned a copy; only agent addresses are.
export function isAgentAddress(participant: string): boolean {
  return participant.includes("@") && !participant.startsWith("prn_");
}

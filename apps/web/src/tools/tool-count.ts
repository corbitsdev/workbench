/** One voice for server tool counts: the Tools page pills and the drawer
 * headers read from the same helper so their numbers can never drift apart. */
export function toolCountLabel(count: number): string {
  return `${String(count)} tool${count === 1 ? "" : "s"}`;
}

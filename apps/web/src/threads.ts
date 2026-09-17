// Thread-native derivation: DMs are participant-filtered threads over
// supplied stock mail snapshots — never tenants, never custom
// idempotency keys. Creation idempotency rides the native Message-ID the
// hub stamps and returns; the client only ever dedupes replays by that id.
// The message shape mirrors the stock `@intx/mime` parse output
// (messageId, inReplyTo, references, listId, cc), so these pure helpers
// apply unchanged once stock mailbox search/thread reads land.

export type ThreadMessage = {
  readonly messageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject?: string;
  readonly listId?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
};

export type Thread = {
  readonly key: string;
  readonly rootMessageId: string;
  readonly messageIds: string[];
};

export type DmThread = {
  /** The exactly-one non-user participant: the other side of the DM. */
  readonly agentAddress: string;
  readonly rootMessageId: string;
  readonly messageIds: string[];
};

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Membership is the To/Cc participant set: From plus To plus Cc. */
export function participantsOf(message: ThreadMessage): Set<string> {
  const members = new Set<string>([normalizeAddress(message.from)]);
  for (const address of [...message.to, ...(message.cc ?? [])]) {
    members.add(normalizeAddress(address));
  }
  return members;
}

function normalizeSubject(subject: string): string {
  return subject
    .replace(/^\s*(re|fwd|fw|aw)(\s*\[[^\]]*\]|\s*:)+\s*/i, "")
    .trim()
    .toLowerCase();
}

function parentIdOf(message: ThreadMessage, knownIds: Set<string>): string | undefined {
  if (message.inReplyTo !== undefined && knownIds.has(message.inReplyTo)) {
    return message.inReplyTo;
  }
  const references = message.references ?? [];
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const candidate = references[index];
    if (candidate !== undefined && knownIds.has(candidate)) return candidate;
  }
  return undefined;
}

/** Groups supplied messages into threads: shared List-ID wins (M:N via
 * the List-ID header where the hub carries it), then In-Reply-To/References
 * chains, then normalized-subject fallback scoped to a single participant
 * set — two reply-less groups sharing a subject but talking to different
 * correspondents never merge (each 1:1 pair keeps its own thread), while
 * same-participant groups with matching subjects still join. Input order
 * decides roots. */
export function deriveThreads(messages: readonly ThreadMessage[]): Thread[] {
  const knownIds = new Set(messages.map((message) => message.messageId));
  const parent = new Map<string, string>();
  for (const message of messages) {
    const parentId = parentIdOf(message, knownIds);
    if (parentId !== undefined) parent.set(message.messageId, parentId);
  }
  const rootOf = (messageId: string): string => {
    let current = messageId;
    for (;;) {
      const next = parent.get(current);
      if (next === undefined) return current;
      current = next;
    }
  };

  type Group = { members: ThreadMessage[]; listId?: string; subject?: string };
  const participantKeyOf = (group: Group): string => {
    const members = new Set<string>();
    for (const member of group.members) {
      for (const participant of participantsOf(member)) members.add(participant);
    }
    return JSON.stringify([...members].sort());
  };
  const byRoot = new Map<string, Group>();
  for (const message of messages) {
    const root = rootOf(message.messageId);
    let group = byRoot.get(root);
    if (group === undefined) {
      group = { members: [] };
      byRoot.set(root, group);
    }
    group.members.push(message);
    if (group.listId === undefined && message.listId !== undefined) {
      group.listId = message.listId;
    }
    if (group.subject === undefined && message.subject !== undefined) {
      group.subject = message.subject;
    }
  }

  const merged = new Map<string, Group>();
  const solo: Group[] = [];
  for (const group of byRoot.values()) {
    if (group.listId !== undefined) {
      const key = `list:${group.listId}`;
      const existing = merged.get(key);
      if (existing === undefined) merged.set(key, group);
      else existing.members.push(...group.members);
      continue;
    }
    const subject = group.subject === undefined ? "" : normalizeSubject(group.subject);
    if (subject === "") {
      solo.push(group);
      continue;
    }
    const key = `subject:${subject}\u0000participants:${participantKeyOf(group)}`;
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, group);
    else existing.members.push(...group.members);
  }

  return [...merged.entries(), ...solo.map((group) => ["", group] as const)].map(
    ([key, group]) => ({
      key: key === "" ? `message:${group.members[0]?.messageId}` : key,
      rootMessageId: group.members[0]?.messageId ?? "",
      messageIds: group.members.map((message) => message.messageId),
    }),
  );
}

/** Derives DMs: threads whose participant set is the user's principal
 * chain plus exactly one agent chain. Group threads, user-only threads,
 * and agent-only threads are not DMs. */
export function deriveDmThreads(
  messages: readonly ThreadMessage[],
  userAddresses: readonly string[],
): DmThread[] {
  const users = new Set(userAddresses.map(normalizeAddress));
  const derived: DmThread[] = [];
  for (const thread of deriveThreads(messages)) {
    const byId = new Map(messages.map((message) => [message.messageId, message]));
    const members = new Set<string>();
    for (const messageId of thread.messageIds) {
      const message = byId.get(messageId);
      if (message === undefined) continue;
      for (const member of participantsOf(message)) members.add(member);
    }
    const hasUser = [...members].some((member) => users.has(member));
    const others = [...members].filter((member) => !users.has(member));
    if (!hasUser || others.length !== 1 || others[0] === undefined) continue;
    derived.push({
      agentAddress: others[0],
      rootMessageId: thread.rootMessageId,
      messageIds: thread.messageIds,
    });
  }
  return derived;
}

export type ForkReference = {
  readonly inReplyTo: string;
  readonly references: string[];
};

/** Builds the native fork ancestry for a sub-thread first message: the
 * parent becomes In-Reply-To and closes the References chain. Pure and
 * ready for the stock submission route once it accepts headers; until
 * then the linkage rides the client-held thread store beside created ids. */
export function buildForkReference(parent: {
  readonly messageId: string;
  readonly references?: readonly string[];
}): ForkReference {
  const ancestry = [...(parent.references ?? [])];
  if (ancestry.at(-1) !== parent.messageId) ancestry.push(parent.messageId);
  return { inReplyTo: parent.messageId, references: ancestry };
}

/** Native Message-ID replay check: a returned id already recorded for its
 * intent means the send already happened — never resend, never mint a
 * custom key. Kept as the single shared definition of that rule (rather
 * than inlining `includes` at each send site) so every send wrapper
 * compares returned ids against recorded ones through one tested helper. */
export function isDuplicateMessageId(
  seenMessageIds: readonly string[],
  messageId: string,
): boolean {
  return seenMessageIds.includes(messageId);
}

// DMs are participant-filtered threads, never tenants, never custom
// idempotency keys — the client only dedupes by the hub's native Message-ID.

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

/** Shared List-ID wins, then In-Reply-To/References chains, then
 * normalized-subject scoped to a single participant set — two reply-less
 * groups sharing a subject never merge across different correspondents. */
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

/** Parent becomes In-Reply-To and closes the References chain. Pure; the
 * linkage still rides the client-held thread store until a stock route
 * accepts these headers directly. */
export function buildForkReference(parent: {
  readonly messageId: string;
  readonly references?: readonly string[];
}): ForkReference {
  const ancestry = [...(parent.references ?? [])];
  if (ancestry.at(-1) !== parent.messageId) ancestry.push(parent.messageId);
  return { inReplyTo: parent.messageId, references: ancestry };
}

// The single shared definition of the replay rule, so every send wrapper
// compares ids through one tested helper rather than inlining `includes`.
export function isDuplicateMessageId(
  seenMessageIds: readonly string[],
  messageId: string,
): boolean {
  return seenMessageIds.includes(messageId);
}

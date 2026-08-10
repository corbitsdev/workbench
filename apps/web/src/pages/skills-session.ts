// Session-local skills registry. There is no hub skill store yet; drafts
// created in this browser tab live here so both col2 (list) and the stage
// (detail) can share the same rows without inventing persistence.

import { useSyncExternalStore } from "react";

export type SkillVersion = {
  readonly version: string;
  readonly note: string;
  readonly who: string;
  readonly whenIso: string;
  readonly current: boolean;
};

export type Skill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly access: "Shared" | "Private";
  readonly owner: string;
  readonly updatedAt: string;
  readonly version: string;
  readonly pinnedBy: readonly string[];
  readonly versions: readonly SkillVersion[];
  /** True when this row only lives in the current browser session. */
  readonly sessionLocal: boolean;
};

type Listener = () => void;

let skills: readonly Skill[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getSessionSkills(): readonly Skill[] {
  return skills;
}

export function setSessionSkills(next: readonly Skill[]): void {
  skills = next;
  emit();
}

export function addSessionSkill(skill: Skill): void {
  skills = [skill, ...skills];
  emit();
}

export function updateSessionSkills(
  updater: (prev: readonly Skill[]) => readonly Skill[],
): void {
  skills = updater(skills);
  emit();
}

export function subscribeSessionSkills(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook over the session-local skills list. */
export function useSessionSkills(): readonly Skill[] {
  return useSyncExternalStore(
    subscribeSessionSkills,
    getSessionSkills,
    getSessionSkills,
  );
}

/** Test helper — resets session drafts between cases. */
export function resetSessionSkills(next: readonly Skill[] = []): void {
  skills = next;
  emit();
}

import { LARRY_SKILL_CONTENT } from './larry/skill';
import { HAMMY_SKILL_CONTENT } from './hammy-the-humanizer/skill';

export interface SkillEntry {
  id: string;
  title: string;
  description: string;
  version: string;
  author: string;
  content: string;
}

export const SKILLS_REGISTRY: readonly SkillEntry[] = [
  {
    id: 'larry',
    title: 'Larry — last30days Research',
    description:
      'Multi-source research skill: extracts entities, fans out to HN, Reddit, GitHub, X, web, then synthesizes a structured brief with clusters, bestTakes, and citations.',
    version: '1.0.0',
    author: 'Workbench',
    content: LARRY_SKILL_CONTENT,
  },
  {
    id: 'hammy',
    title: 'Hammy — Humanizer',
    description:
      'Rewrite AI-generated content to read as human-authored. Includes a scoring rubric (0–100) and a strict vocabulary blocklist.',
    version: '1.0.0',
    author: 'Workbench',
    content: HAMMY_SKILL_CONTENT,
  },
] as const;

export function getSkillById(id: string): SkillEntry | undefined {
  return SKILLS_REGISTRY.find((s) => s.id === id);
}

export function listSkills(): readonly SkillEntry[] {
  return SKILLS_REGISTRY;
}

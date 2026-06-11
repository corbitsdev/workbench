import { LARRY_SKILL_CONTENT } from './skill';

export function buildLarrySystemPrompt(agentName: string): string {
  return [
    `You are ${agentName}.`,
    '',
    LARRY_SKILL_CONTENT,
    '',
    'Use only the tools attached to this agent and keep findings grounded in retrieved sources.',
  ].join('\n');
}

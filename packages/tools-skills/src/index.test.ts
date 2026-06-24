import { describe, expect, it } from 'bun:test';
import {
  LIST_SKILLS_DEFINITION,
  LOAD_SKILL_DEFINITION,
  SEARCH_SKILLS_DEFINITION,
  SKILL_TOOL_DEFINITIONS,
  parseSearchQuery,
  parseSkillId,
  skillMatchesQuery,
  type SkillIndexEntry,
} from './index';

describe('skill tool definitions', () => {
  it('exposes exactly the three read-only tools', () => {
    expect(SKILL_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual([
      'list_skills',
      'load_skill',
      'search_skills',
    ]);
  });

  it('list_skills takes no required args', () => {
    expect(LIST_SKILLS_DEFINITION.inputSchema.required).toEqual([]);
  });

  it('search_skills requires query and load_skill requires id', () => {
    expect(SEARCH_SKILLS_DEFINITION.inputSchema.required).toEqual(['query']);
    expect(LOAD_SKILL_DEFINITION.inputSchema.required).toEqual(['id']);
  });
});

describe('parseSearchQuery', () => {
  it('returns the query string', () => {
    expect(parseSearchQuery({ query: 'deck' })).toBe('deck');
  });

  it('throws on a missing query', () => {
    expect(() => parseSearchQuery({})).toThrow('search_skills');
  });

  it('throws on an empty query', () => {
    expect(() => parseSearchQuery({ query: '' })).toThrow('search_skills');
  });

  it('throws on a non-string query', () => {
    expect(() => parseSearchQuery({ query: 7 })).toThrow('search_skills');
  });
});

describe('parseSkillId', () => {
  it('returns the id string', () => {
    expect(parseSkillId({ id: 'asset_1' })).toBe('asset_1');
  });

  it('throws on a missing id', () => {
    expect(() => parseSkillId({})).toThrow('load_skill');
  });

  it('throws on an empty id', () => {
    expect(() => parseSkillId({ id: '' })).toThrow('load_skill');
  });
});

describe('skillMatchesQuery', () => {
  const entry: SkillIndexEntry = {
    id: 'a1',
    name: 'deck-builder',
    displayName: 'Deck Builder',
  };

  it('matches a substring of the name (case-insensitive)', () => {
    expect(skillMatchesQuery(entry, 'DECK')).toBe(true);
  });

  it('matches a substring of the display name (case-insensitive)', () => {
    expect(skillMatchesQuery(entry, 'deck builder')).toBe(true);
  });

  it('does not match an unrelated query', () => {
    expect(skillMatchesQuery(entry, 'spreadsheet')).toBe(false);
  });

  it('treats a blank query as matching everything', () => {
    expect(skillMatchesQuery(entry, '   ')).toBe(true);
  });

  it('tolerates a null displayName', () => {
    const sparse: SkillIndexEntry = {
      id: 'a2',
      name: 'lonely',
      displayName: null,
    };
    expect(skillMatchesQuery(sparse, 'lonely')).toBe(true);
    expect(skillMatchesQuery(sparse, 'nope')).toBe(false);
  });
});

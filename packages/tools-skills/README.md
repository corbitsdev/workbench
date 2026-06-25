# @workbench/tools-skills

Read-only, on-demand access to the tenant-visible skill library with progressive
disclosure. These tools coexist with per-agent skill attachment — they let an
agent (Myra) reach the _whole_ library it can see, rather than only the skills
pinned to it.

## Tools

| Tool            | Args                | Returns                                                                                                                           |
| --------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `list_skills`   | none                | `{ skills: [{ id, name, displayName, description }] }` — a cheap index, never the skill body.                                     |
| `search_skills` | `{ query: string }` | Same index shape, filtered by a case-insensitive substring match over `name` + `displayName` + `description`.                     |
| `load_skill`    | `{ id: string }`    | `{ id, name, displayName, body, files }` — the `SKILL.md` body with frontmatter stripped, plus the contents of any sibling files. |

All three are READ-ONLY: they never create, update, or delete skills.

## Wiring

These are **hub-backed** tools. The definitions and the pure search/parse helpers
live here; execution happens hub-side because skill content lives in the
hub-owned asset git store and visibility is resolved against hub-owned tables.

- `src/interchange-tools.ts` exports the `defineHubBackedToolPackage` factory,
  which forwards each call to the hub's `/api/internal/hub-tools/run` endpoint.
- The hub handler is `apps/hub/src/tools/list-skills.ts` (`SKILLS_HUB_TOOLS`),
  registered in both `KNOWN_TOOLS` and `HUB_BACKED_TOOLS`. It resolves the
  caller's **stable user id** (`principal.refId`) and delegates visibility to
  the existing `skill-library` service (`listSkills`, `getSkillAsset`,
  `getSkillContent`) — the same rules the skills UI and the workflow-skills
  resolver use.

## Visibility

A skill is visible when its tenant is in the viewer's tenant ancestor chain and
it is either tenant-scoped or private-and-owned-by-the-viewer (`isSkillVisible`).
`list_skills` / `search_skills` exclude anything not visible; `load_skill` reports
an invisible id as not found. A principal that does not resolve to an active user
fails closed (empty list / not found).

## Credentials

Keyless. There is no credential `providerName`, no `credentialRequirements`
entry, and **no `seed-credentials` entry** — do not add one.

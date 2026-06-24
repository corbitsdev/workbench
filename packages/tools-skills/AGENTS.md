# @workbench/tools-skills

Read-only skill library access with progressive disclosure. Registered in the
hub's tool registry as `list_skills`, `search_skills`, and `load_skill`.

- Hub-backed (no provider credential): the definitions live here; execution
  happens hub-side over `/api/internal/hub-tools/run` because skill content is in
  the hub-owned asset git store and visibility is resolved against hub-owned
  tables. The hub handler is `apps/hub/src/tools/list-skills.ts`.
- `list_skills` / `search_skills` return a cheap index only (`{id, name,
displayName, description}`) — never the skill body. `load_skill` returns the
  stripped `SKILL.md` body plus sibling file contents for one skill.
- Visibility is delegated to the `skill-library` service and keyed on the
  caller's stable user id (`principal.refId`), not the synthetic instance
  principal. An invisible skill is excluded from list/search and reported as not
  found on load; an unresolvable principal fails closed.
- READ-ONLY — these tools never mutate the library.
- The tool grants (`tool:<name>/invoke`) are synthesized at session launch from
  the agent's capabilities list; do not add them to the DB.
- Keyless: no `seed-credentials` entry, no credential provider.
- These tools COEXIST with per-agent skill attachment — they reach the whole
  visible library, they do not replace pinned skills.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.

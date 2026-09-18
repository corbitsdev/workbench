# @corbits/skills-tools

SKILL.md authoring and the pinned-skills prompt index, plus every
skills-related `@intx/agent` tool in one bundle:

- `skillsManageTools` — `list_skills`, `read_skill`, `create_skill`,
  `update_skill`, `pin_skill`: Myra's in-chat way to capture know-how as a
  skill and pin one onto an agent definition.
- `skillsQueryTools` — `skills_list`, `skills_search`, `skills_load`: the
  agent-facing half, turning an `<available_skills>` index entry into the
  skill's full body.

`skill-md.ts` and `prompt.ts` are internal modules re-exported from the
package root because `@corbits/agent-directory` still consumes
`skillNameSchema`, `PinnedSkillIndexEntry`, and `withAvailableSkills`
directly.

## Running tests

```sh
cd tools/skills && bun test
```

# @workbench/workflow-sumble-account-intel

A human-in-the-loop account intelligence workflow. Given an account (company
domain or Sumble slug), it researches the account across Sumble — resolving the
organization, then pulling teams, open jobs, technology stack, contacts, and
buying signals — enriches each contact with an X/Twitter search (Sumble returns
LinkedIn-sourced people only), synthesizes a reviewable account intelligence
brief (including a contacts CSV and a Slack-ready draft), and, after human
approval, persists the brief as a `research` artifact.

## Flow

1. `intake` — human names the account (`organizationDomain`, optional `pushToAttio`).
2. `resolve` — `sumble_resolve_organization` (load-bearing; not best-effort).
3. `teams` / `jobs` — `sumble_list_teams` / `sumble_list_jobs` (org shape).
4. `techStack` — `sumble_get_org_tech_stack`.
5. `contacts` — `sumble_search_people`.
6. `signals` — `sumble_search_signals`.
7. `enrichSocial` — `map` over the contacts running a per-contact `x_search`.
8. `synthesize` — inline inference (`LLM_WRITER_MODEL`) producing strict JSON.
9. `review` — human approves the brief.
10. `packageArtifact` — `write_artifact` persists the brief.

Every Sumble/X fetch after `resolve` is `nonFatal`: a dead source degrades to a
recorded skip rather than failing the run.

## Attio push — intentionally out of band (not a v1 dependency)

The intake and review gates collect a `pushToAttio` flag, but the workflow does
NOT include an Attio step. The `@intx/workflow` runtime's only conditional
primitive is `gate`, an exclusive-OR **branch** (routes to a `then` step or an
`else` step and skips the not-selected branch's closure). It cannot express
"optionally run one extra trailing side-effect step" without introducing a
no-op `else` leaf — a stub, which the repo's "no stubs" rule forbids. Combined
with the product constraint that **CRM sync (Attio) must not be a v1
dependency**, the Attio push is intentionally left as an out-of-band follow-up:
the approved brief carries the operator's `pushToAttio` intent for a downstream
consumer to act on, and no Attio call runs inside this workflow.

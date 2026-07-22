# Prospect engine (`prospect-engine`)

Overnight unattended Workbench workflow (CL-3497): Sumble discovery → qualify → map/reveal → artifact + Slack digest.

## Schedule

- Target: **02:00 America/New_York** via hub scheduler / personal schedule picker (CL-2609 / CL-2297).
- **Kill switch:** Owner → Schedules → select Prospect engine → Pause (and Resume). Two clicks, no eng.
- Fully **gate-free** (no Myra approval on the path).

## Operator config (until tenant constants ship)

Schedule payload / intake fields:

| Field                    | Notes                                          |
| ------------------------ | ---------------------------------------------- |
| `slackChannelId`         | #prospect-engine channel id (CL-3717)          |
| `growthEngineListId`     | Sumble "Engine - Growth" list id (CL-3703)     |
| `enterpriseEngineListId` | Sumble "Engine - Enterprise" list id (CL-3703) |

## Hard caps

- 800 Sumble credits / 45 minutes per run (fail-closed via `prospect_engine_*` tools).
- Email reveal top 2–3 contacts/account; no phones.
- Writes: nightly artifact, Engine Growth/Enterprise lists, Slack digest, durable ledger memory. **No Attio writes. No outreach.**

## Supervised first run checklist

1. Confirm Sumble API key on tenant + `GetMyCompanyProfile` (profile may be wrong; scoring uses rubric).
2. Confirm Engine list ids and Slack channel id on the schedule.
3. Manual `workflow_start` with Joe watching (daytime).
4. Verify: 10–15 scored accounts, zero pipeline list 80088 overlap, digest posts, artifact readable, night-2 ledger dedupe.
5. Enable 2am ET schedule only after sign-off.

## Graph

See `src/index.ts`. Pattern matches heartbeat: deterministic hub tools + agent steps, no host-level action/loop vendoring.

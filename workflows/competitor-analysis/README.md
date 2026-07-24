# Competitor Analysis

Research a company from its website, discover top competitors with public
evidence (Exa + Firecrawl), and save a reviewable competitor report.

## Kind

`competitor-analysis`

## How to run

1. Start the workflow from Workbench (catalog / Myra / dock).
2. **Intake** — company website URL (required), optional company name and focus notes.
3. Wait while the run scrapes the site, profiles the company, searches for
   alternatives, and drafts the report.
4. **Review** — approve to save, or reject.
5. Open the saved research artifact in the workbench.

### Credentials

Tenant must have:

- **Firecrawl** (site scrape + optional peer scrapes)
- **Exa** (web discovery search)
- **LLM** (profile / discover / synthesize)

### Deploy

```bash
bun run admin -- push-workflow competitor-analysis
```

(Use `admin:staging` / `admin:production` as appropriate.)

## Steps

| Step              | Kind               | What it does                                                      |
| ----------------- | ------------------ | ----------------------------------------------------------------- |
| `intake`          | awaitSignal        | Company URL (+ optional name / focus)                             |
| `scrape`          | `firecrawl_scrape` | Crawl the company site                                            |
| `profile`         | inline inference   | Subject profile + discovery search queries                        |
| `discover`        | tool-using agent   | `exa_search` + optional `firecrawl_scrape` → competitor shortlist |
| `synthesize`      | inline inference   | Markdown report + competitor cards                                |
| `review`          | awaitSignal        | Human approve / reject                                            |
| `packageArtifact` | `write_artifact`   | Persist as research artifact                                      |

## Methodology

Encoded in prompts (not a separate product surface):

1. **Define the subject** from their own site (not model memory).
2. **Discover alternatives** with public evidence (search hits, comparison pages, peer sites).
3. **Segment** each peer: `direct` / `indirect` / `adjacent` / `status_quo`.
4. **Shortlist** roughly 3–7 direct peers; lighter indirect/adjacent when evidence is clear.
5. **Grounding** — never invent peers when tools return little; empty fields over speculation.
6. **Human gate** before persist; no CRM side effects.

## Artifact

One `research` artifact via `write_artifact`:

| Field      | Value                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| `kind`     | `research`                                                              |
| `jobLabel` | `Competitor analysis`                                                   |
| `title`    | Company URL from intake                                                 |
| `body`     | Synthesize step reply (JSON with markdown `content` + competitor cards) |

Structured fields inside the body (for UI / future consumers):

- Subject brief (name, category, thesis, ICP, positioning)
- Competitor cards: `name`, `website?`, `segment`, `whyCompetes`, `positioning?`, `sources[]`

## Out of scope

- Multi-layer teardown studio (positioning → strengths → gaps → differentiation)
- Attio / CRM writes
- Continuous competitive monitoring

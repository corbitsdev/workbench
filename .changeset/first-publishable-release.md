---
"@corbits/access-tools": minor
"@corbits/agent-directory-tools": minor
"@corbits/assistant-workflow": minor
"@corbits/attio-task-agent-workflow": minor
"@corbits/capability-tools": minor
"@corbits/catalog-tools": minor
"@corbits/code-review": minor
"@corbits/code-review-workflow": minor
"@corbits/collateral-generation-workflow": minor
"@corbits/connections-tools": minor
"@corbits/diligence-brief-workflow": minor
"@corbits/echo-workflow": minor
"@corbits/error-sink": minor
"@corbits/exa-topic-watch-workflow": minor
"@corbits/github-tools": minor
"@corbits/granola-call-workflow": minor
"@corbits/granola-tools": minor
"@corbits/heartbeat-workflow": minor
"@corbits/interaction-tools": minor
"@corbits/last-30-days-research-workflow": minor
"@corbits/linear-tools": minor
"@corbits/manus-tools": minor
"@corbits/mcp-tools": minor
"@corbits/memory-tools": minor
"@corbits/morning-brief-workflow": minor
"@corbits/pain-point-collateral-workflow": minor
"@corbits/process-granola-call-workflow": minor
"@corbits/reddit-opportunity-scanner-workflow": minor
"@corbits/reddit-tools": minor
"@corbits/skills-tools": minor
"@corbits/tools-skills": minor
"@corbits/web-search-tools": minor
"@corbits/workbench-digest-workflow": minor
"@corbits/workflow-authoring-tools": minor
---

First publishable release: every @corbits workflow and tool package
publishes to npm.

CL-8167 wires up the changesets-driven publish pipeline (a version PR on
push to main, a provenance-signed `npm publish` after that version PR
merges, and a dry-run pack + `npm publish --dry-run` on every pull
request). This changeset gives the pipeline something to release: a
minor bump for every package CL-8157 made publishable.

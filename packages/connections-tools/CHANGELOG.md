# @corbits/connections-tools

## 0.1.0

### Minor Changes

- a16a7e3: First publishable release: every @corbits workflow and tool package
  publishes to npm.

  CL-8167 wires up the changesets-driven publish pipeline (a version PR on
  push to main, a provenance-signed `npm publish` after that version PR
  merges, and a dry-run pack + `npm publish --dry-run` on every pull
  request). This changeset gives the pipeline something to release: a
  minor bump for every package CL-8157 made publishable.

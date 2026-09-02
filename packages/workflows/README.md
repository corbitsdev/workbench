# @corbits/workflows

The workflow domain package: `./source` (the two-file source codebase
every authoring path renders/reads), `./deploy-source` (the durable
deploy-source record), `./detail` (the definition detail read a
workflow's own page uses), and `./authoring` (letting an agent author,
republish, and deploy a workflow through Interchange's native source
pipeline).

Server code imports `@corbits/workflows`; browser code imports
`@corbits/workflows/client` for the browser-safe subset (source
constants, the definition-detail wire schema, and the pure lifecycle
derivation).

# Myra's hand-built definition.json

`buildMyraDefinitionJson` in `apps/web/src/myra-deploy.ts` is the
function-free projection of what `@corbits/myra`'s `buildMyraWorkflow`
produces, written to the asset's `definition.json` for readers — the entry
itself is a bundle no reader can slice apart.

It is hand-built here rather than by calling that function, because
`buildMyraWorkflow` goes through `@intx/workflow`'s `defineWorkflow`/`step`,
which pull in `@intx/agent`'s Node-bound runtime (file locking) that a
browser bundle cannot resolve.

It mirrors `defineWorkflow`'s own normalization
(`vendor/intx/workflow/src/definition/workflow.ts`'s `normalize`/
`applyDefaultInputStep`, and `primitives.ts`'s `step`): a single step with no
`after` gets `input: { from: "trigger.payload" }`; `triggers: "unbounded"`
(not the numeric default) gets `drainBehavior: "wait"`; a bare `trigger`
becomes a one-element `triggers` array.

`toolFactories` and `toolPackagePins` are empty on purpose: the real
factories ride the bundle, and JSON cannot carry a function.

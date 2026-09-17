// The detail symbols are the browser-safe `../client` barrel's canonical
// export site — re-exported here rather than redeclared, so there is
// exactly one place that owns this list and the two barrels cannot drift
// apart. There is no hub route here — see
// `./definition-detail.ts`'s header for why.
export {
  workflowNotLaunchableReason,
  workflowDetailPath,
  WorkflowDefinitionDetail,
} from "../client";

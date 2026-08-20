// The `interchange.workflow` entry the code-sourced deploy evaluates.
//
// Nothing imports this module statically. The approval probe and the run
// child each import it out of the materialized closure, read the same
// deploy-time config out of the environment, and must arrive at the same
// definition — the child refuses to run one whose recomputed wire hash
// differs from the approved one.
import { readAgentRuntimeConfig } from "./config";
import { buildAgentRuntimeWorkflow } from "./definition";

export default buildAgentRuntimeWorkflow(readAgentRuntimeConfig(process.env));

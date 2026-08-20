// The checked-in recordings, parsed once through the fixture schema so
// a caller (scripts/evals-run.ts wiring a fake into `bootMyraTarget`)
// never re-reads the JSON path itself.
import githubJson from "./recordings/github.json";

import { parseMcpFakeRecording, type McpFakeRecording } from "./recording.ts";

export const GITHUB_MCP_FAKE_RECORDING: McpFakeRecording =
  parseMcpFakeRecording(githubJson);

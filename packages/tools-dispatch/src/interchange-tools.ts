// Native `interchange.tools` entry for @workbench/tools-dispatch.
//
// dispatch_agent orchestrates a hub-side launch (sessions, grants, mail),
// so this is a hub-backed package: the factory carries only the tool
// definition and forwards each call to the hub's scoped
// `/api/internal/hub-tools/run` endpoint.
//
// The definition lives on its own module (no hub-session imports) so the
// packed sidecar tarball stays self-contained.

import { defineHubBackedToolPackage } from '@workbench/tool-credentials/factory';
import { DISPATCH_AGENT_DEFINITION } from './definition';

export const dispatch = defineHubBackedToolPackage({
  id: '@workbench/tools-dispatch/dispatch',
  definitions: [DISPATCH_AGENT_DEFINITION],
});

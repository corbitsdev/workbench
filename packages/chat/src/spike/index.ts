// CL-6323 Phase 0 spike surface. Everything under this directory is
// throwaway: mounted only behind WORKBENCH_SPIKE_ROOMS=1 and removable
// with one `git rm packages/chat/src/spike`.

export { ensureSpikeTables, createSpikeRoomStore } from "./room-store";
export type { SpikeRoom, SpikeMessage, SpikeRoomStore } from "./room-store";
export {
  createSpikeRoomRoutes,
  createSpikeRoomSubscribers,
} from "./room-routes";
export type { SpikeRoomSubscribers } from "./room-routes";
export { dispatchTurn, ensureRoomRun } from "./room-run";
export type { SpikeRoomEvent, SpikeRoomRunDeps } from "./room-run";
export {
  SPIKE_ROOM_SECTION_ID,
  buildSpikeRoomWorkflow,
  spikeTurnChildRunId,
} from "./room-workflow";

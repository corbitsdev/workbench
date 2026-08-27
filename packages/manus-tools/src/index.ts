export {
  CreateTaskResponse,
  ListMessagesResponse,
  createSlideDeck,
  createTask,
  extractOutputFiles,
  latestAgentStatus,
  listTaskMessages,
  manusRequest,
  DEFAULT_MANUS_BASE_URL,
  DEFAULT_SLIDE_MAX_POLLS,
  DEFAULT_SLIDE_POLL_INTERVAL_MS,
  SLIDES_FORMAT_PPTX,
} from "./client";
export type {
  CreateSlideDeckParams,
  CreateTaskParams,
  ListMessagesParams,
  ManusClientConfig,
  OutputFile,
  TaskAttachment,
  TaskEvent,
} from "./client";
export {
  CREATE_SLIDES_TOOL,
  MANUS_CREDENTIAL_HANDLE,
  MANUS_ENDPOINTS,
  MANUS_NOT_CONNECTED,
  manusTools,
} from "./tool";
export type { ManusEnv } from "./tool";

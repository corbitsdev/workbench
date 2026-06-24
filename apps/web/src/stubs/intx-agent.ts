// Browser stub for @intx/agent — a server-only package that uses node:path
// and other Node built-ins. In dev mode Vite doesn't tree-shake, so something
// in the dep graph loads it eagerly. This stub satisfies the import without
// pulling in any Node dependencies. Production builds tree-shake it out.

export class AgentContextLockError extends Error {}
export class DuplicateToolError extends Error {}
export class AgentEnvError extends Error {}
export class CanonicalizationError extends Error {}
export class UnknownDirectorIdError extends Error {}
export class InvalidInferenceSourceError extends Error {}
export class SourceNotFoundError extends Error {}
export class AgentClosedError extends Error {}
export class SendQueueFullError extends Error {}
export class StreamBackpressureError extends Error {}

export const PLUGIN_MARKER = Symbol('plugin');
export const TOOL_PLUGIN_KIND = 'tool-plugin' as const;

export const createToolRunner = () => {
  throw new AgentContextLockError('server only');
};
export const defineTool = () => {
  throw new AgentContextLockError('server only');
};
export const definePlugin = () => {
  throw new AgentContextLockError('server only');
};
export const fromToolRunner = () => {
  throw new AgentContextLockError('server only');
};
export const isAnnotatedPluginFactory = () => false;
export const isToolPluginInstance = () => false;
export const stringTool = () => {
  throw new AgentContextLockError('server only');
};
export const tool = () => {
  throw new AgentContextLockError('server only');
};
export const validateNamespacedId = () => {
  throw new AgentContextLockError('server only');
};
export const canonicalizeForHash = () => {
  throw new AgentContextLockError('server only');
};
export const defineDirector = () => {
  throw new AgentContextLockError('server only');
};
export const createDefaultDirectorRegistry = () => {
  throw new AgentContextLockError('server only');
};
export const createDirectorRegistry = () => {
  throw new AgentContextLockError('server only');
};
export const buildDefaultDirectorRef = () => {
  throw new AgentContextLockError('server only');
};
export const defaultDirectorFactory = () => {
  throw new AgentContextLockError('server only');
};
export const createSourceRegistry = () => {
  throw new AgentContextLockError('server only');
};
export const createAgent = () => {
  throw new AgentContextLockError('server only');
};
export const defineAgent = () => {
  throw new AgentContextLockError('server only');
};
export const effectiveDirectorRef = () => {
  throw new AgentContextLockError('server only');
};
export const getRequiredEnvKeys = () => {
  throw new AgentContextLockError('server only');
};
export const validateEnv = () => {
  throw new AgentContextLockError('server only');
};

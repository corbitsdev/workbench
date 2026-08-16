import { resolve } from "node:path";

import { type } from "arktype";

const Environment = type({
  DOCKER_PROVISIONER_IMAGE: "string > 0",
  "DOCKER_PROVISIONER_DATA_DIR?": "string > 0",
});

const DEFAULT_DATA_DIR = ".data/docker-provisioner";

export type DockerProvisionerConfig = {
  readonly image: string;
  readonly stateFilePath: string;
};

/**
 * Parse the docker provisioner's configuration out of an environment map.
 * Throws at the call site, listing every problem at once, so a
 * misconfigured process dies at boot instead of failing at first use.
 */
export function readDockerProvisionerConfig(
  env: Record<string, string | undefined>,
): DockerProvisionerConfig {
  const parsed = Environment(env);
  if (parsed instanceof type.errors) {
    throw new Error(
      `invalid docker provisioner environment: ${parsed.summary}`,
    );
  }
  const dataDir = resolve(parsed.DOCKER_PROVISIONER_DATA_DIR ?? DEFAULT_DATA_DIR);
  return {
    image: parsed.DOCKER_PROVISIONER_IMAGE,
    stateFilePath: resolve(dataDir, "state.json"),
  };
}

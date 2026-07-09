import { type } from "arktype";

export type VercelFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type VercelToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: VercelFetch;
};

const DEFAULT_BASE_URL = "https://api.vercel.com";
export const MAX_STATIC_FILE_BYTES = 4_500_000;

const VercelDeploymentResponse = type({
  id: "string",
  "url?": "string",
  "name?": "string",
  "readyState?": "string",
  "inspectUrl?": "string",
});

export type VercelStaticDeployInput = {
  projectName: string;
  files: { path: string; content: string }[];
  teamId?: string;
  target?: "production" | "preview";
};

export type VercelDeploymentResult = {
  id: string;
  url?: string;
  name?: string;
  readyState?: string;
  inspectUrl?: string;
};

function apiUrl(config: VercelToolsConfig, path: string): URL {
  return new URL(path, config.baseUrl ?? DEFAULT_BASE_URL);
}

function withTeamId(url: URL, teamId: string | undefined): void {
  if (teamId !== undefined) {
    url.searchParams.set("teamId", teamId);
  }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) {
    return response.statusText;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      return parsed.error.message;
    }
  } catch {
    return text;
  }
  return text;
}

async function fetchVercelJson(
  config: VercelToolsConfig,
  url: URL,
  init: RequestInit,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Vercel API error: ${response.status} ${await readError(response)}`,
    );
  }
  return response.json();
}

export function normalizeDeployFilePath(filePath: string): string {
  const trimmed = filePath.trim().replace(/\\/g, "/");
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    throw new Error("filePath must be a relative file path without '..'");
  }
  if (segments.length === 0) {
    throw new Error("filePath must not be empty");
  }
  return segments.join("/");
}

export async function deployStaticFilesToVercel(
  config: VercelToolsConfig,
  input: VercelStaticDeployInput,
  signal: AbortSignal,
): Promise<VercelDeploymentResult> {
  if (input.files.length === 0) {
    throw new Error("at least one file is required to deploy");
  }

  let totalBytes = 0;
  const payloadFiles = input.files.map(({ path, content }) => {
    const file = normalizeDeployFilePath(path);
    const size = new TextEncoder().encode(content).byteLength;
    if (size > MAX_STATIC_FILE_BYTES) {
      throw new Error(
        `file ${file} is too large for deployment (${size} bytes)`,
      );
    }
    totalBytes += size;
    if (totalBytes > MAX_STATIC_FILE_BYTES) {
      throw new Error(
        `total deployment size exceeds ${MAX_STATIC_FILE_BYTES} bytes`,
      );
    }
    return {
      file,
      data: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64" as const,
    };
  });

  const url = apiUrl(config, "/v13/deployments");
  withTeamId(url, input.teamId);

  const raw = await fetchVercelJson(config, url, {
    method: "POST",
    signal,
    body: JSON.stringify({
      name: input.projectName,
      target: input.target ?? "preview",
      projectSettings: { framework: null },
      files: payloadFiles,
    }),
  });
  const response = VercelDeploymentResponse(raw);
  if (response instanceof type.errors) {
    throw new Error(`Vercel deployment response invalid: ${response.summary}`);
  }
  const result: VercelDeploymentResult = { id: response.id };
  if (response.url !== undefined) {
    result.url = `https://${response.url}`;
  }
  if (response.name !== undefined) {
    result.name = response.name;
  }
  if (response.readyState !== undefined) {
    result.readyState = response.readyState;
  }
  if (response.inspectUrl !== undefined) {
    result.inspectUrl = response.inspectUrl;
  }
  return result;
}

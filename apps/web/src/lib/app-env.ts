import { type } from "arktype";

const AppEnvSchema = type("'production' | 'staging' | 'spike'");

export type AppEnv = typeof AppEnvSchema.infer;

const ENV_LABELS: Record<AppEnv, string | null> = {
  production: null,
  staging: "Staging",
  spike: "Spike",
};

const BASE_TITLE = "Workbench";
const PARENT_BRAND = "Corbits";

export interface Branding {
  env: AppEnv | null;
  label: string | null;
  title: string;
}

export function deriveBranding(rawEnv: string | undefined): Branding {
  const parsed = AppEnvSchema(rawEnv);
  const env = parsed instanceof type.errors ? null : parsed;
  const label = env ? ENV_LABELS[env] : null;
  const product = label ? `${BASE_TITLE} ${label}` : BASE_TITLE;
  return { env, label, title: `${product} | ${PARENT_BRAND}` };
}

export const branding = deriveBranding(import.meta.env.VITE_APP_ENV);

declare module "bun" {
  interface Env {
    PORT?: string;
    DB_HOST?: string;
    DB_PORT?: string;
    DB_USER?: string;
    DB_PASSWORD?: string;
    DB_NAME?: string;
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_BASE_URL?: string;
    CORS_ORIGIN?: string;
    WEB_URL?: string;
  }
}

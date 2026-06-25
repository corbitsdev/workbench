// Shared @workbench/client options for the web app. Points the framework-
// agnostic client at this app's hub. Same-origin when VITE_API_BASE_URL is
// unset (matches lib/api.ts behavior).
import type { ClientOptions } from "@workbench/client";

const baseUrl = import.meta.env.VITE_API_BASE_URL || undefined;

export const clientOptions: ClientOptions = baseUrl ? { baseUrl } : {};

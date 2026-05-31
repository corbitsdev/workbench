import { createAuthClient } from 'better-auth/client';

const baseURL =
  import.meta.env.PROD && import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL : '';

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    credentials: 'include',
  },
});

export const { signIn, signOut, useSession } = authClient;

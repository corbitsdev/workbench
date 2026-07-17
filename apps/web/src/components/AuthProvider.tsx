import {
  useEffect,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  hydrateServerPreferences,
  setPreferencePersister,
} from "@workbench/ui";
import { authClient } from "../lib/auth-client";
import { invalidateMeSyncCache, postMe } from "../lib/hub-api";
import { createPreferencesPersister } from "../lib/preferences-persister";

type Session =
  | { status: "loading" }
  | {
      status: "authenticated";
      user: {
        id: string;
        email: string;
        name: string;
        image?: string | null;
      };
    }
  | { status: "unauthenticated" };

interface AuthContextValue {
  session: Session;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["auth-session"],
    queryFn: async () => {
      const { data } = await authClient.getSession();
      return data ?? null;
    },
    staleTime: 5 * 60_000,
  });

  // Route preference writes through a debounced server PATCH for the app's
  // lifetime; the localStorage cache in the store keeps reads instant.
  useEffect(() => {
    const { persist, flush } = createPreferencesPersister();
    setPreferencePersister(persist);
    function flushOnHide() {
      if (document.visibilityState === "hidden") flush();
    }
    document.addEventListener("visibilitychange", flushOnHide);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHide);
      flush();
      setPreferencePersister(null);
    };
  }, []);

  useEffect(() => {
    if (isLoading || !data?.user) return;
    void postMe({ syncPersonalAgent: false })
      .then((me) => {
        if (me.preferences) hydrateServerPreferences(me.preferences);
      })
      .catch(() => {
        // Non-fatal: provisioning guard and chat connect will retry sync.
      });
  }, [isLoading, data?.user?.id]);

  const session: Session = isLoading
    ? { status: "loading" }
    : data?.user
      ? {
          status: "authenticated",
          user: {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
            image: data.user.image,
          },
        }
      : { status: "unauthenticated" };

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      }
    }
    function handleFocus() {
      void queryClient.invalidateQueries({ queryKey: ["auth-session"] });
    }
    window.addEventListener("focus", handleFocus);
    window.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [queryClient]);

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    invalidateMeSyncCache();
    queryClient.setQueryData(["auth-session"], null);
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ session, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

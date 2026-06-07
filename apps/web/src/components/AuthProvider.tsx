import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { authClient } from '../lib/auth-client';

type Session =
  | { status: 'loading' }
  | {
      status: 'authenticated';
      user: {
        id: string;
        email: string;
        name: string;
        image?: string | null;
      };
    }
  | { status: 'unauthenticated' };

interface AuthContextValue {
  session: Session;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  const checkSession = useCallback(async () => {
    try {
      const { data } = await authClient.getSession();
      if (data?.user) {
        setSession({
          status: 'authenticated',
          user: {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
            image: data.user.image,
          },
        });
      } else if (import.meta.env.DEV) {
        setSession({
          status: 'authenticated',
          user: {
            id: 'dev-user',
            email: 'dev@example.com',
            name: 'Dev User',
          },
        });
      } else {
        setSession({ status: 'unauthenticated' });
      }
    } catch {
      if (import.meta.env.DEV) {
        setSession({
          status: 'authenticated',
          user: {
            id: 'dev-user',
            email: 'dev@example.com',
            name: 'Dev User',
          },
        });
      } else {
        setSession({ status: 'unauthenticated' });
      }
    }
  }, []);

  useEffect(() => {
    checkSession();
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') checkSession();
    }
    window.addEventListener('focus', checkSession);
    window.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('focus', checkSession);
      window.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [checkSession]);

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    setSession({ status: 'unauthenticated' });
  }, []);

  return (
    <AuthContext.Provider value={{ session, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

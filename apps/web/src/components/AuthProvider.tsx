import { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { authClient } from '../lib/auth-client';
import { LoginPage } from '../pages/LoginPage';

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
  if (!ctx) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
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
      } else {
        setSession({ status: 'unauthenticated' });
      }
    } catch {
      setSession({ status: 'unauthenticated' });
    }
  }, []);

  useEffect(() => {
    checkSession();
    const onFocus = () => checkSession();
    window.addEventListener('focus', onFocus);
    window.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('visibilitychange', onFocus);
    };
  }, [checkSession]);

  const handleSignOut = useCallback(async () => {
    await authClient.signOut();
    setSession({ status: 'unauthenticated' });
  }, []);

  if (session.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (session.status === 'unauthenticated') {
    return <LoginPage />;
  }

  return (
    <AuthContext.Provider value={{ session, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

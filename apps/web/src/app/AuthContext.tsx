import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

import { verifyAdminToken } from '../api/client';
import { queryClient } from './queryClient';

const LS_ADMIN_TOKEN_KEY = 'admin_token';
const AUTH_SENSITIVE_PUBLIC_QUERY_KEYS = [
  ['status'],
  ['homepage'],
  ['latency'],
  ['public-incidents'],
  ['public-maintenance-windows'],
  ['public-day-context'],
  ['public-monitor-outages'],
] as const;

function resetAuthSensitivePublicQueries() {
  for (const key of AUTH_SENSITIVE_PUBLIC_QUERY_KEYS) {
    queryClient.resetQueries({ queryKey: key });
  }
}

type AuthStatus = 'unauthenticated' | 'checking' | 'authenticated';

interface AuthContextValue {
  status: AuthStatus;
  isAuthenticated: boolean;
  token: string | null;
  login: (token: string) => Promise<void>;
  logout: () => void;
  ensureValidToken: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const raw = localStorage.getItem(LS_ADMIN_TOKEN_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  });

  const [status, setStatus] = useState<AuthStatus>(() => (token ? 'checking' : 'unauthenticated'));

  const verifyInFlight = useRef<Promise<boolean> | null>(null);
  const didInitTokenSync = useRef(false);

  useEffect(() => {
    if (!didInitTokenSync.current) {
      didInitTokenSync.current = true;
      if (!token) return;
    }

    resetAuthSensitivePublicQueries();
  }, [token]);

  const logout = useCallback(() => {
    localStorage.removeItem(LS_ADMIN_TOKEN_KEY);
    setToken(null);
    setStatus('unauthenticated');
    verifyInFlight.current = null;
  }, []);

  const ensureValidToken = useCallback(async (): Promise<boolean> => {
    if (!token) {
      setStatus('unauthenticated');
      return false;
    }

    if (status === 'authenticated') return true;

    if (verifyInFlight.current) {
      return verifyInFlight.current;
    }

    setStatus('checking');

    const p = verifyAdminToken(token)
      .then(() => {
        setStatus('authenticated');
        return true;
      })
      .catch(() => {
        // Token might have been rotated/invalidated. Clear it to avoid letting the
        // user into the admin UI with a broken session.
        logout();
        return false;
      })
      .finally(() => {
        verifyInFlight.current = null;
      });

    verifyInFlight.current = p;
    return p;
  }, [logout, status, token]);

  const login = useCallback(
    async (nextToken: string) => {
      const trimmed = nextToken.trim();
      if (!trimmed) throw new Error('Missing token');

      setStatus('checking');
      verifyInFlight.current = null;

      try {
        await verifyAdminToken(trimmed);
      } catch (err) {
        logout();
        throw err;
      }

      localStorage.setItem(LS_ADMIN_TOKEN_KEY, trimmed);
      setToken(trimmed);
      setStatus('authenticated');
    },
    [logout],
  );

  const value = useMemo<AuthContextValue>(() => {
    return {
      status,
      isAuthenticated: status === 'authenticated',
      token: status === 'authenticated' ? token : null,
      login,
      logout,
      ensureValidToken,
    };
  }, [ensureValidToken, login, logout, status, token]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

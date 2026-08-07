import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { config } from '../config';
import {
  getStoredTenantId,
  getStoredToken,
  setStoredTenantId,
  setStoredToken,
} from './session';

export interface AuthState {
  token: string | null;
  tenantId: string | null;
  authMode: typeof config.authMode;
  isAuthenticated: boolean;
  setToken: (token: string | null) => void;
  setTenantId: (tenantId: string | null) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getStoredToken());
  const [tenantId, setTenantState] = useState<string | null>(() => getStoredTenantId());

  const setToken = useCallback((next: string | null) => {
    setStoredToken(next);
    setTokenState(next);
  }, []);

  const setTenantId = useCallback((next: string | null) => {
    setStoredTenantId(next);
    setTenantState(next);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setTenantId(null);
  }, [setToken, setTenantId]);

  const value = useMemo<AuthState>(
    () => ({
      token,
      tenantId,
      authMode: config.authMode,
      isAuthenticated: Boolean(token),
      setToken,
      setTenantId,
      signOut,
    }),
    [token, tenantId, setToken, setTenantId, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth requires AuthProvider');
  return ctx;
}

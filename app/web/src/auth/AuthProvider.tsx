import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api, fetchMe, setCsrfToken, type MeResponse, type Settings } from '../api/client';

interface AuthState {
  status: 'loading' | 'anonymous' | 'authenticated';
  user: MeResponse['user'] | null;
  settings: Settings | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
}
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: true });
  const refresh = useCallback(async () => { await qc.invalidateQueries({ queryKey: ['me'] }); await qc.refetchQueries({ queryKey: ['me'] }); }, [qc]);
  const signOutM = useMutation({
    mutationFn: () => api('POST', '/api/auth/logout', {}),
    onSettled: () => { setCsrfToken(null); qc.clear(); qc.setQueryData(['me'], null); },
  });
  const settingsM = useMutation({
    mutationFn: (patch: Partial<Settings>) => api<Settings>('PATCH', '/api/settings', patch),
    onMutate: async (patch) => {                                   // optimistic: the viewer background flips immediately
      const prev = qc.getQueryData<MeResponse | null>(['me']);
      if (prev) qc.setQueryData<MeResponse>(['me'], { ...prev, settings: { ...prev.settings, ...patch } });
      return { prev };
    },
    onError: (_e, _p, ctx) => { if (ctx?.prev) qc.setQueryData(['me'], ctx.prev); },
    onSuccess: (s) => { const cur = qc.getQueryData<MeResponse | null>(['me']); if (cur) qc.setQueryData<MeResponse>(['me'], { ...cur, settings: s }); },
  });
  const value = useMemo<AuthState>(() => ({
    status: q.isLoading ? 'loading' : q.data ? 'authenticated' : 'anonymous',
    user: q.data?.user ?? null,
    settings: q.data?.settings ?? null,
    refresh,
    signOut: async () => { await signOutM.mutateAsync().catch(() => {}); },
    updateSettings: async (p) => { await settingsM.mutateAsync(p); },
  }), [q.isLoading, q.data, refresh, signOutM, settingsM]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}

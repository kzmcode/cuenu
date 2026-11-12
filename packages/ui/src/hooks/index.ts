import type { RepoEvent, SyncStatus } from '@cuenu/core';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { usePlatform } from '../platform';

/** repo.subscribe の購読（listener は最新を参照） */
export function useRepoEvents(listener: (e: RepoEvent) => void): void {
  const { repo } = usePlatform();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => repo.subscribe((e) => ref.current(e)), [repo]);
}

const OFFLINE_STATUS: SyncStatus = {
  configured: false,
  online: false,
  syncing: false,
  pendingOps: 0,
  lastSyncedAt: null,
  lastError: null,
  initialImportDone: false,
  conflicts: 0,
};

export function useSyncStatus(): SyncStatus | null {
  const { sync } = usePlatform();
  const [status, setStatus] = useState<SyncStatus | null>(() => (sync ? safeStatus(sync.status) : null));
  useEffect(() => {
    if (sync) setStatus(safeStatus(sync.status));
  }, [sync]);
  useRepoEvents((e) => {
    if (e.type === 'sync-status') setStatus(e.status);
  });
  return status;
}

function safeStatus(get: () => SyncStatus): SyncStatus {
  try {
    return get();
  } catch {
    return OFFLINE_STATUS;
  }
}

export function useOnline(): boolean {
  const { isOnline } = usePlatform();
  const read = () => (isOnline ? isOnline() : typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const readRef = useRef(read);
  readRef.current = read;
  const [online, setOnline] = useState(read);
  // 毎レンダーで付け外ししないよう、登録は 1 回だけにして最新の read を参照する
  useEffect(() => {
    const on = () => setOnline(readRef.current());
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  useRepoEvents((e) => {
    if (e.type === 'sync-status') setOnline(read());
  });
  return online;
}

/** 認証状態（auth.subscribe があれば追従） */
export function useLoggedIn(): boolean {
  const { auth } = usePlatform();
  const [v, setV] = useState(() => auth?.isLoggedIn() ?? false);
  useEffect(() => {
    if (!auth) return;
    setV(auth.isLoggedIn());
    return auth.subscribe?.(() => setV(auth.isLoggedIn()));
  }, [auth]);
  return v;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** textarea の高さを内容に合わせる */
export function useAutoResize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

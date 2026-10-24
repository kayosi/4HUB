import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError | Error }
  | { status: 'ready'; data: T };

/**
 * Runs `fn` on mount, whenever `key` changes, and when `reload()` is called.
 * Loading is derived (the stored result belongs to an older key) so no state is set synchronously in the effect.
 */
export function useAsync<T>(fn: () => Promise<T>, key = ''): AsyncState<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [res, setRes] = useState<{ k: string; state: Exclude<AsyncState<T>, { status: 'loading' }> } | null>(null);
  const k = `${key}#${tick}`;

  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setRes({ k, state: { status: 'ready', data } }),
      (error) => live && setRes({ k, state: { status: 'error', error } }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const state: AsyncState<T> = res && res.k === k ? res.state : { status: 'loading' };
  return { ...state, reload };
}

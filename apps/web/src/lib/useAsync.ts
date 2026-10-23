import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError | Error }
  | { status: 'ready'; data: T };

/** Runs `fn` on mount and again whenever `reload()` is called. */
export function useAsync<T>(fn: () => Promise<T>): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setState({ status: 'ready', data }),
      (error) => live && setState({ status: 'error', error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    setTick((t) => t + 1);
  }, []);

  return { ...state, reload };
}

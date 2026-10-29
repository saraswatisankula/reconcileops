import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Loads a GET endpoint and exposes data/error/loading plus a reload function.
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(path);
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

// Wraps an async action with a busy flag so buttons can't be double-clicked.
export function useAction(fn) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (...args) => {
    if (busy) return undefined;
    setBusy(true);
    try {
      return await fn(...args);
    } finally {
      setBusy(false);
    }
  }, [fn, busy]);
  return [run, busy];
}

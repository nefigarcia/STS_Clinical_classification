"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/fetch";

/**
 * Fetch JSON from an internal API route. `reload()` refetches; `pollMs` refreshes periodically.
 * State is only set from async callbacks, never synchronously inside the effect.
 */
export function useApi<T>(url: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const [loadedAt, setLoadedAt] = useState(0);
  const reload = useCallback(() => setKey((k) => k + 1), []);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const run = () =>
      api<T>(url)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
          setLoadedAt(Date.now());
        })
        .catch((e: Error) => alive && setError(e.message));
    run();
    const t = opts.pollMs ? setInterval(run, opts.pollMs) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [url, key, opts.pollMs]);

  return { data, error, reload, loadedAt };
}

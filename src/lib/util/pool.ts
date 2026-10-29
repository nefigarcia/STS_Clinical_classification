/**
 * Run `fn` over `items` with at most `limit` in flight. Stops scheduling new items once
 * `shouldStop()` returns true (already-started items finish). Returns results in input order;
 * items never started are `undefined`. The first error rejects after in-flight work settles.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  // Dense array (not `new Array(n)`): unstarted slots must be real `undefined`s, not holes skipped by .some().
  const results: (R | undefined)[] = Array.from({ length: items.length }, () => undefined);
  let next = 0;
  let error: unknown = null;
  const worker = async () => {
    while (error === null && !shouldStop()) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (error === null) error = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (error !== null) throw error;
  return results;
}

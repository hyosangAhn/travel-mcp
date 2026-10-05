// KV-backed cache for slow-changing, flaky upstream data (festivals).
// Fresh for `freshSeconds`; after that we refetch, but keep the old copy for
// STALE_KEEP_SECONDS so a data.go.kr outage can still be answered from it.
// Without a CACHE binding this is a pass-through.

const STALE_KEEP_SECONDS = 3 * 24 * 3600;

type Entry<T> = { savedAt: number; value: T };

export async function cached<T>(
  kv: KVNamespace | undefined,
  key: string,
  freshSeconds: number,
  load: () => Promise<T>,
): Promise<{ value: T; cache?: string }> {
  if (!kv) return { value: await load() };

  const hit = await kv.get<Entry<T>>(key, "json").catch(() => null);
  const ageSec = hit ? (Date.now() - hit.savedAt) / 1000 : Infinity;
  if (hit && ageSec < freshSeconds) return { value: hit.value, cache: `hit (${Math.round(ageSec / 60)}분 전 데이터)` };

  try {
    const value = await load();
    await kv.put(key, JSON.stringify({ savedAt: Date.now(), value } satisfies Entry<T>), {
      expirationTtl: STALE_KEEP_SECONDS,
    });
    return { value };
  } catch (e) {
    if (hit) {
      return { value: hit.value, cache: `stale (원본 조회 실패로 ${Math.round(ageSec / 3600)}시간 전 데이터를 대신 사용)` };
    }
    throw e;
  }
}

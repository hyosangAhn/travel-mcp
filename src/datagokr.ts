// Shared caller for apis.data.go.kr services (TourAPI, 기상청, TAGO, ...).
// They all use the same account-level serviceKey but each service must be
// approved separately on data.go.kr ("활용신청").

export type Item = Record<string, string | number | undefined>;

const SUCCESS = new Set(["00", "0000"]);

export async function callDataGoKr(
  apiKey: string,
  url: string,
  params: Record<string, string | number | undefined>,
): Promise<{ items: Item[]; totalCount: number }> {
  const u = new URL(url);
  // serviceKey must be the *Decoding* key; URLSearchParams handles encoding.
  u.searchParams.set("serviceKey", apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
  }

  const res = await fetch(u);
  const text = await res.text();
  const service = u.pathname.split("/").slice(2).join("/");
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // Gateway errors (unregistered key, quota, unknown service) are XML regardless of _type.
    const msg = text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1] ?? text.slice(0, 300);
    throw new Error(`${service} failed (HTTP ${res.status}): ${msg}`);
  }
  const gw = json?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) {
    const hint = gw.errMsg === "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" ? " — data.go.kr에서 이 서비스를 활용신청했는지 확인" : "";
    throw new Error(`${service} failed: ${gw.returnAuthMsg ?? gw.errMsg}${hint}`);
  }

  const header = json?.response?.header;
  if (header?.resultCode === "03") return { items: [], totalCount: 0 }; // 기상청 NO_DATA
  if (header && !SUCCESS.has(header.resultCode)) {
    throw new Error(`${service} error ${header.resultCode}: ${header.resultMsg}`);
  }
  const body = json?.response?.body;
  const raw = body?.items?.item; // array, single object, or "" when empty
  const items: Item[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { items, totalCount: Number(body?.totalCount ?? items.length) };
}

/** Lower-case every key so callers don't depend on each service's casing quirks. */
export const lowerKeys = (it: Item): Item =>
  Object.fromEntries(Object.entries(it).map(([k, v]) => [k.toLowerCase(), v]));

/** Current time in KST as YYYYMMDD / HHMM parts. */
export function kstNow(offsetMinutes = 0) {
  const d = new Date(Date.now() + (9 * 60 + offsetMinutes) * 60_000);
  const iso = d.toISOString(); // already shifted to KST
  return { date: iso.slice(0, 10).replaceAll("-", ""), hhmm: iso.slice(11, 16).replace(":", ""), d };
}

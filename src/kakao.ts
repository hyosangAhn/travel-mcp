// Kakao Local API + Kakao Mobility directions. Both use the same REST API key.
// Local:    https://developers.kakao.com/docs/latest/ko/local/dev-guide
// Mobility: https://developers.kakaomobility.com/docs/navi-api/directions/

export type Point = { name: string; address?: string; x: number; y: number };

const ATTEMPT_TIMEOUT_MS = 5000;

/** Almost every tool geocodes through Kakao, so a hung call would stall all of them: time out and retry once. */
async function kakaoGet(apiKey: string, url: URL) {
  let res: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, {
        headers: { Authorization: `KakaoAK ${apiKey}` },
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (res.status < 500) break;
    } catch (e) {
      if (attempt === 1) throw new Error(`Kakao API ${url.pathname} failed: ${e instanceof Error ? e.name : e}`);
    }
  }
  const json: any = await res!.json().catch(() => ({}));
  if (!res!.ok) {
    // Kakao echoes a malformed key back ("wrong appKey(<key>) format"); never pass it on to the model.
    const msg = String(json.msg ?? json.message ?? "").replaceAll(apiKey, "***");
    throw new Error(`Kakao API ${url.pathname} failed (HTTP ${res!.status}): ${msg}`);
  }
  return json;
}

export const CATEGORY_CODES = {
  음식점: "FD6",
  카페: "CE7",
  관광명소: "AT4",
  숙박: "AD5",
  문화시설: "CT1",
  주차장: "PK6",
  주유소: "OL7",
  지하철역: "SW8",
  편의점: "CS2",
  대형마트: "MT1",
} as const;

export type CategoryName = keyof typeof CATEGORY_CODES;

export async function searchKeyword(
  apiKey: string,
  opts: { query: string; categoryCode?: string; x?: number; y?: number; radius?: number; limit: number },
) {
  const url = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
  url.searchParams.set("query", opts.query);
  url.searchParams.set("size", String(opts.limit));
  if (opts.categoryCode) url.searchParams.set("category_group_code", opts.categoryCode);
  if (opts.x !== undefined && opts.y !== undefined) {
    url.searchParams.set("x", String(opts.x));
    url.searchParams.set("y", String(opts.y));
    url.searchParams.set("radius", String(opts.radius ?? 2000));
    url.searchParams.set("sort", "distance");
  }
  const json = await kakaoGet(apiKey, url);
  return (json.documents ?? []).map((d: any) => ({
    name: d.place_name,
    category: d.category_name,
    address: d.road_address_name || d.address_name,
    phone: d.phone || undefined,
    x: Number(d.x),
    y: Number(d.y),
    distanceM: d.distance ? Number(d.distance) : undefined,
    url: d.place_url,
  }));
}

/**
 * Resolve a place name or address to coordinates.
 * Address search first, so regions ("가평군", "제주시 애월읍") resolve to the region itself
 * instead of whichever POI ranks first for that keyword (가평군 -> 국립유명산자연휴양림).
 * Place names ("강릉역", "경포대") don't match as addresses and fall through to keyword search.
 */
export async function geocode(apiKey: string, query: string): Promise<Point> {
  const url = new URL("https://dapi.kakao.com/v2/local/search/address.json");
  url.searchParams.set("query", query);
  url.searchParams.set("analyze_type", "exact");
  url.searchParams.set("size", "1");
  const doc = (await kakaoGet(apiKey, url)).documents?.[0];
  if (doc) return { name: query, address: doc.address_name, x: Number(doc.x), y: Number(doc.y) };

  const [hit] = await searchKeyword(apiKey, { query, limit: 1 });
  if (hit) return { name: hit.name, address: hit.address, x: hit.x, y: hit.y };
  throw new Error(`위치를 찾을 수 없음: "${query}"`);
}

/** 좌표의 법정동 코드. sido = 앞 2자리, sigungu = 앞 5자리 (data.go.kr lDong 코드와 같은 체계). */
export async function regionCode(apiKey: string, x: number, y: number) {
  const url = new URL("https://dapi.kakao.com/v2/local/geo/coord2regioncode.json");
  url.searchParams.set("x", String(x));
  url.searchParams.set("y", String(y));
  const json = await kakaoGet(apiKey, url);
  const b = (json.documents ?? []).find((d: any) => d.region_type === "B");
  if (!b) throw new Error(`법정동 코드를 찾을 수 없음 (${x}, ${y})`);
  return {
    code: String(b.code),
    sido: String(b.code).slice(0, 2),
    sigungu: String(b.code).slice(0, 5),
    name: [b.region_1depth_name, b.region_2depth_name].filter(Boolean).join(" "),
  };
}

export async function carRoute(
  apiKey: string,
  origin: Point,
  destination: Point,
  waypoints: Point[],
  priority: "RECOMMEND" | "TIME" | "DISTANCE",
) {
  const url = new URL("https://apis-navi.kakaomobility.com/v1/directions");
  url.searchParams.set("origin", `${origin.x},${origin.y}`);
  url.searchParams.set("destination", `${destination.x},${destination.y}`);
  if (waypoints.length) url.searchParams.set("waypoints", waypoints.map((p) => `${p.x},${p.y}`).join("|"));
  url.searchParams.set("priority", priority);
  url.searchParams.set("summary", "true");

  const json = await kakaoGet(apiKey, url);
  const route = json.routes?.[0];
  if (!route || route.result_code !== 0) {
    throw new Error(`경로 탐색 실패: ${route?.result_msg ?? "no route"}`);
  }
  const s = route.summary;
  const stops = [origin, ...waypoints, destination];
  return {
    totalDistanceKm: +(s.distance / 1000).toFixed(1),
    totalDurationMin: Math.round(s.duration / 60),
    taxiFareKrw: s.fare?.taxi,
    tollFareKrw: s.fare?.toll,
    legs: (route.sections ?? []).map((sec: any, i: number) => ({
      from: stops[i]?.name,
      to: stops[i + 1]?.name,
      distanceKm: +(sec.distance / 1000).toFixed(1),
      durationMin: Math.round(sec.duration / 60),
    })),
    stops,
  };
}

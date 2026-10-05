// 한국관광공사 TourAPI (KorService2) client.
// Docs: https://www.data.go.kr/data/15101578/openapi.do

const BASE = "https://apis.data.go.kr/B551011/KorService2";

export const CONTENT_TYPES = {
  관광지: "12",
  문화시설: "14",
  축제공연행사: "15",
  여행코스: "25",
  레포츠: "28",
  숙박: "32",
  쇼핑: "38",
  음식점: "39",
} as const;

// 법정동 시도 코드 (lDongRegnCd). 신규 데이터는 구 areaCode가 비어 있어 이 코드로 필터해야 한다.
export const AREA_CODES = {
  서울: "11",
  인천: "28",
  대전: "30",
  대구: "27",
  광주: "29",
  부산: "26",
  울산: "31",
  세종: "36",
  경기: "41",
  강원: "51",
  충북: "43",
  충남: "44",
  경북: "47",
  경남: "48",
  전북: "52",
  전남: "46",
  제주: "50",
} as const;

export type ContentTypeName = keyof typeof CONTENT_TYPES;
export type AreaName = keyof typeof AREA_CODES;

type Item = Record<string, string | number | undefined>;

async function call(
  apiKey: string,
  operation: string,
  params: Record<string, string | number | undefined>,
): Promise<{ items: Item[]; totalCount: number }> {
  const url = new URL(`${BASE}/${operation}`);
  // serviceKey must be the *Decoding* key; URLSearchParams handles encoding.
  url.searchParams.set("serviceKey", apiKey);
  url.searchParams.set("MobileOS", "ETC");
  url.searchParams.set("MobileApp", "travel-mcp");
  url.searchParams.set("_type", "json");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // Auth/quota errors come back as XML regardless of _type.
    const msg = text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1] ?? text.slice(0, 300);
    throw new Error(`TourAPI ${operation} failed (HTTP ${res.status}): ${msg}`);
  }

  const header = json?.response?.header;
  if (header && header.resultCode !== "0000") {
    throw new Error(`TourAPI ${operation} error ${header.resultCode}: ${header.resultMsg}`);
  }
  const body = json?.response?.body;
  const raw = body?.items?.item; // array, single object, or "" when empty
  const items: Item[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return { items, totalCount: Number(body?.totalCount ?? items.length) };
}

function summarize(it: Item) {
  return {
    contentId: it.contentid,
    contentTypeId: it.contenttypeid,
    title: it.title,
    address: [it.addr1, it.addr2].filter(Boolean).join(" ") || undefined,
    tel: it.tel || undefined,
    x: it.mapx ? Number(it.mapx) : undefined,
    y: it.mapy ? Number(it.mapy) : undefined,
    image: it.firstimage || undefined,
    distanceM: it.dist !== undefined ? Math.round(Number(it.dist)) : undefined,
  };
}

export async function searchKeyword(
  apiKey: string,
  opts: { keyword: string; contentTypeId?: string; areaCode?: string; limit: number; page: number },
) {
  const { items, totalCount } = await call(apiKey, "searchKeyword2", {
    keyword: opts.keyword,
    contentTypeId: opts.contentTypeId,
    lDongRegnCd: opts.areaCode,
    numOfRows: opts.limit,
    pageNo: opts.page,
    arrange: "Q", // 수정일순, 대표이미지 있는 항목 우선
  });
  return { totalCount, places: items.map(summarize) };
}

export async function locationBased(
  apiKey: string,
  opts: { x: number; y: number; radius: number; contentTypeId?: string; limit: number; page: number },
) {
  const { items, totalCount } = await call(apiKey, "locationBasedList2", {
    mapX: opts.x,
    mapY: opts.y,
    radius: opts.radius,
    contentTypeId: opts.contentTypeId,
    numOfRows: opts.limit,
    pageNo: opts.page,
    arrange: "E", // 거리순
  });
  return { totalCount, places: items.map(summarize) };
}

export async function searchFestival(
  apiKey: string,
  opts: { startDate: string; endDate?: string; areaCode?: string; limit: number; page: number },
) {
  const { items, totalCount } = await call(apiKey, "searchFestival2", {
    eventStartDate: opts.startDate,
    eventEndDate: opts.endDate,
    lDongRegnCd: opts.areaCode,
    numOfRows: opts.limit,
    pageNo: opts.page,
    arrange: "A",
  });
  return {
    totalCount,
    festivals: items.map((it) => ({
      ...summarize(it),
      startDate: it.eventstartdate,
      endDate: it.eventenddate,
    })),
  };
}

const stripHtml = (s: unknown) =>
  typeof s === "string" ? s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : s;

export async function detail(apiKey: string, contentId: string) {
  const common = (await call(apiKey, "detailCommon2", { contentId })).items[0];
  if (!common) throw new Error(`contentId ${contentId} not found`);

  // detailIntro2 holds type-specific fields (opening hours, parking, rest days, menu...).
  let intro: Item | undefined;
  try {
    intro = (await call(apiKey, "detailIntro2", { contentId, contentTypeId: common.contenttypeid })).items[0];
  } catch {
    intro = undefined;
  }
  const introClean = intro
    ? Object.fromEntries(
        Object.entries(intro)
          .filter(([k, v]) => v !== "" && v !== undefined && k !== "contentid" && k !== "contenttypeid")
          .map(([k, v]) => [k, stripHtml(v)]),
      )
    : undefined;

  return {
    ...summarize(common),
    homepage: stripHtml(common.homepage) || undefined,
    overview: stripHtml(common.overview) || undefined,
    intro: introClean,
  };
}

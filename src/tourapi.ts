// 한국관광공사 TourAPI (KorService2) client.
// Docs: https://www.data.go.kr/data/15101578/openapi.do

import { callDataGoKr, type Item } from "./datagokr";

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

// 숙박 분류 (lclsSystm3). lclsSystmCode2?lclsSystm1=AC 로 조회한 값.
export const STAY_TYPES = {
  호텔: "AC010100",
  콘도: "AC020100",
  레지던스: "AC020200",
  펜션: "AC030100",
  한옥스테이: "AC030200",
  농어촌민박: "AC030300",
  홈스테이: "AC030400",
  모텔: "AC040100",
  일반야영장: "AC050100",
  오토캠핑장: "AC050200",
  카라반: "AC050300",
  글램핑장: "AC050400",
  유스호스텔: "AC060100",
  게스트하우스: "AC060200",
} as const;

const STAY_TYPE_NAMES = Object.fromEntries(Object.entries(STAY_TYPES).map(([k, v]) => [v, k]));

export type ContentTypeName = keyof typeof CONTENT_TYPES;
export type StayTypeName = keyof typeof STAY_TYPES;
export type AreaName = keyof typeof AREA_CODES;

function call(apiKey: string, operation: string, params: Record<string, string | number | undefined>) {
  return callDataGoKr(apiKey, `${BASE}/${operation}`, { MobileOS: "ETC", MobileApp: "travel-mcp", _type: "json", ...params });
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

export async function searchStay(
  apiKey: string,
  opts: {
    stayType?: string;
    areaCode?: string;
    near?: { x: number; y: number; radius: number };
    limit: number;
    page: number;
  },
) {
  const common = { lclsSystm3: opts.stayType, numOfRows: opts.limit, pageNo: opts.page };
  const { items, totalCount } = opts.near
    ? await call(apiKey, "locationBasedList2", {
        ...common,
        contentTypeId: CONTENT_TYPES.숙박,
        mapX: opts.near.x,
        mapY: opts.near.y,
        radius: opts.near.radius,
        arrange: "E",
      })
    : await call(apiKey, "searchStay2", { ...common, lDongRegnCd: opts.areaCode, arrange: "Q" });
  return {
    totalCount,
    stays: items.map((it) => ({ ...summarize(it), stayType: STAY_TYPE_NAMES[String(it.lclsSystm3)] })),
  };
}

const fee = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);

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

  // 숙박은 detailInfo2에 객실별 인원과 비수기/성수기 요금이 있다 (업체가 등록한 참고값).
  let rooms: unknown[] | undefined;
  if (String(common.contenttypeid) === CONTENT_TYPES.숙박) {
    try {
      const { items } = await call(apiKey, "detailInfo2", { contentId, contentTypeId: CONTENT_TYPES.숙박 });
      rooms = items.map((r) => ({
        name: r.roomtitle,
        sizePyeong: r.roomsize1 || undefined,
        baseGuests: r.roombasecount ? Number(r.roombasecount) : undefined,
        maxGuests: r.roommaxcount ? Number(r.roommaxcount) : undefined,
        offSeasonWeekdayKrw: fee(r.roomoffseasonminfee1),
        offSeasonWeekendKrw: fee(r.roomoffseasonminfee2),
        peakSeasonWeekdayKrw: fee(r.roompeakseasonminfee1),
        peakSeasonWeekendKrw: fee(r.roompeakseasonminfee2),
        note: stripHtml(r.roomintro) || undefined,
      }));
    } catch {
      rooms = undefined;
    }
  }

  return {
    ...summarize(common),
    homepage: stripHtml(common.homepage) || undefined,
    overview: stripHtml(common.overview) || undefined,
    intro: introClean,
    rooms: rooms?.length ? rooms : undefined,
  };
}

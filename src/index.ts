import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { cached } from "./cache";
import { crowdForecast } from "./crowd";
import { kstNow } from "./datagokr";
import * as kakao from "./kakao";
import * as tour from "./tourapi";
import * as transport from "./transport";
import * as weather from "./weather";

export interface Env {
  TOUR_API_KEY: string;
  KAKAO_REST_KEY: string;
  /** Secret path segment: the MCP endpoint is served at /mcp/<MCP_PATH_TOKEN>. */
  MCP_PATH_TOKEN: string;
  /** Optional KV namespace for caching festival lists. Without it, calls go straight to data.go.kr. */
  CACHE?: KVNamespace;
}

// Compact JSON: indentation is pure token overhead for the model reading it.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

const contentType = z
  .enum(Object.keys(tour.CONTENT_TYPES) as [tour.ContentTypeName, ...tour.ContentTypeName[]])
  .optional()
  .describe("관광 정보 유형. 생략하면 전체");
const area = z
  .enum(Object.keys(tour.AREA_CODES) as [tour.AreaName, ...tour.AreaName[]])
  .optional()
  .describe("광역 지역. 생략하면 전국. 광주와 전남은 전남광주통합특별시로 합쳐져 어느 쪽을 골라도 둘 다 나온다");
const limit = z.number().int().min(1).max(30).default(10).describe("결과 개수");
const page = z.number().int().min(1).default(1).describe("페이지 번호");
const location = z.string().min(1).describe('장소명이나 주소 (예: "강릉역", "제주시 애월읍")');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):?[0-5]\d$/);
const date = z.string().regex(/^\d{8}$/).describe("날짜 (YYYYMMDD)");

function buildServer(env: Env) {
  const server = new McpServer({ name: "travel-mcp", version: "0.1.0" });

  server.registerTool(
    "search_places",
    {
      title: "관광지 키워드 검색",
      description:
        "한국관광공사 TourAPI에서 키워드로 관광지, 음식점, 숙박, 문화시설 등을 검색한다. 결과의 contentId로 get_place_detail을 호출할 수 있다.",
      inputSchema: z.object({ keyword: z.string().min(1), contentType, area, limit, page }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ keyword, contentType, area, limit, page }) => {
      try {
        return ok(
          await tour.searchKeyword(env.TOUR_API_KEY, {
            keyword,
            contentTypeId: contentType && tour.CONTENT_TYPES[contentType],
            areaCode: area && tour.AREA_CODES[area],
            limit,
            page,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_nearby_places",
    {
      title: "주변 관광 정보",
      description:
        "특정 장소 반경 내의 관광지, 음식점, 숙박 등을 TourAPI에서 거리순으로 찾는다. 장소명은 카카오 검색으로 좌표 변환된다.",
      inputSchema: z.object({
        location,
        radiusM: z.number().int().min(100).max(20000).default(3000).describe("반경(미터), 최대 20000"),
        contentType,
        limit,
        page,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ location, radiusM, contentType, limit, page }) => {
      try {
        const center = await kakao.geocode(env.KAKAO_REST_KEY, location);
        const result = await tour.locationBased(env.TOUR_API_KEY, {
          x: center.x,
          y: center.y,
          radius: radiusM,
          contentTypeId: contentType && tour.CONTENT_TYPES[contentType],
          limit,
          page,
        });
        return ok({ center, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_stays",
    {
      title: "숙소 검색",
      description:
        "TourAPI 숙박 정보를 지역이나 특정 장소 주변으로 검색한다. 한옥스테이, 글램핑장 등 유형으로 거를 수 있다. 객실과 요금은 get_place_detail로 본다. 예약은 지원하지 않는다.",
      inputSchema: z.object({
        area,
        near: z.string().optional().describe("이 장소 주변에서 검색 (area보다 우선)"),
        radiusM: z.number().int().min(100).max(20000).default(5000),
        stayType: z
          .enum(Object.keys(tour.STAY_TYPES) as [tour.StayTypeName, ...tour.StayTypeName[]])
          .optional()
          .describe("숙소 유형. 생략하면 전체"),
        limit,
        page,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ area, near, radiusM, stayType, limit, page }) => {
      try {
        const center = near ? await kakao.geocode(env.KAKAO_REST_KEY, near) : undefined;
        const result = await tour.searchStay(env.TOUR_API_KEY, {
          stayType: stayType && tour.STAY_TYPES[stayType],
          areaCode: area && tour.AREA_CODES[area],
          near: center && { x: center.x, y: center.y, radius: radiusM },
          limit,
          page,
        });
        return ok({ center, ...result });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_place_detail",
    {
      title: "관광 정보 상세",
      description:
        "contentId로 개요, 홈페이지, 이용시간, 휴무일, 주차 등 상세 정보를 가져온다. 숙소면 객실별 인원과 비수기/성수기 요금(업체 등록 참고값)도 준다.",
      inputSchema: z.object({ contentId: z.string().min(1) }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ contentId }) => {
      try {
        return ok(await tour.detail(env.TOUR_API_KEY, contentId));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_festivals",
    {
      title: "축제·행사 검색",
      description: "기간 내에 진행되는 축제와 행사를 찾는다. 날짜 형식은 YYYYMMDD.",
      inputSchema: z.object({
        startDate: z.string().regex(/^\d{8}$/).describe("이 날짜 이후 진행되는 행사 (YYYYMMDD)"),
        endDate: z.string().regex(/^\d{8}$/).optional().describe("이 날짜 이전에 시작하는 행사 (YYYYMMDD)"),
        area,
        limit,
        page,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ startDate, endDate, area, limit, page }) => {
      try {
        // 축제 목록은 하루 단위로 거의 안 바뀐다. 12시간 캐시하고, 포털 장애 때는 이전 결과로 답한다.
        const { value, cache } = await cached(
          env.CACHE,
          `festival:${startDate}:${endDate ?? ""}:${area ?? ""}:${limit}:${page}`,
          12 * 3600,
          () =>
            tour.searchFestival(env.TOUR_API_KEY, {
              startDate,
              endDate,
              areaCode: area && tour.AREA_CODES[area],
              limit,
              page,
            }),
        );
        return ok({ ...value, cache });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_local",
    {
      title: "카카오 장소 검색",
      description:
        "카카오맵 장소 검색. 맛집, 카페, 주차장 등 TourAPI에 없는 일반 장소를 찾을 때 쓴다. near를 주면 그 주변을 거리순으로 찾는다.",
      inputSchema: z.object({
        query: z.string().min(1).describe('검색어 (예: "칼국수", "스타벅스")'),
        near: z.string().optional().describe("이 장소 주변에서 검색"),
        radiusM: z.number().int().min(100).max(20000).default(2000),
        category: z
          .enum(Object.keys(kakao.CATEGORY_CODES) as [kakao.CategoryName, ...kakao.CategoryName[]])
          .optional(),
        limit: z.number().int().min(1).max(15).default(10),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, near, radiusM, category, limit }) => {
      try {
        const center = near ? await kakao.geocode(env.KAKAO_REST_KEY, near) : undefined;
        const places = await kakao.searchKeyword(env.KAKAO_REST_KEY, {
          query,
          categoryCode: category && kakao.CATEGORY_CODES[category],
          x: center?.x,
          y: center?.y,
          radius: radiusM,
          limit,
        });
        return ok({ center, places });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_route_time",
    {
      title: "자동차 이동 시간",
      description:
        "카카오모빌리티 길찾기로 자동차 이동 거리와 소요 시간을 계산한다. 경유지를 주면 구간별 시간도 준다. 대중교통과 도보는 지원하지 않는다.",
      inputSchema: z.object({
        origin: location.describe("출발지"),
        destination: location.describe("도착지"),
        waypoints: z.array(z.string().min(1)).max(5).default([]).describe("경유지 (순서대로, 최대 5개)"),
        priority: z.enum(["RECOMMEND", "TIME", "DISTANCE"]).default("RECOMMEND"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ origin, destination, waypoints, priority }) => {
      try {
        const key = env.KAKAO_REST_KEY;
        const [o, d, ...w] = await Promise.all(
          [origin, destination, ...waypoints].map((q) => kakao.geocode(key, q)),
        );
        return ok(await kakao.carRoute(key, o, d, w, priority));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_weather_forecast",
    {
      title: "날씨 예보",
      description:
        "기상청 예보로 장소의 날짜별 최저/최고기온, 강수확률, 오전/오후 날씨를 준다. 앞쪽 4~5일은 단기예보(5km 격자, source=단기), 그 뒤 10일차까지는 중기예보(광역 단위, source=중기)다.",
      inputSchema: z.object({ location }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ location }) => {
      try {
        const p = await kakao.geocode(env.KAKAO_REST_KEY, location);
        const region = await kakao.regionCode(env.KAKAO_REST_KEY, p.x, p.y);
        const [short, mid] = await Promise.allSettled([
          weather.shortTerm(env.TOUR_API_KEY, p.x, p.y),
          weather.midTerm(env.TOUR_API_KEY, p.x, p.y, region.sido, region.sigungu),
        ]);
        if (short.status === "rejected" && mid.status === "rejected") throw short.reason;
        const midAll = mid.status === "fulfilled" ? mid.value.days : [];
        const midDates = new Set(midAll.map((d) => d.date));
        // Short-term wins, except for its trailing partial day when mid-term covers that date.
        const shortDays = (short.status === "fulfilled" ? short.value.days : [])
          .filter((d) => !(d.partial && midDates.has(d.date)))
          .map(({ partial, ...d }) => d);
        const seen = new Set(shortDays.map((d) => d.date));
        const midDays = midAll.filter((d) => !seen.has(d.date));
        const errors = [short, mid].flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
        return ok({
          location: { ...p, region: region.name },
          midTermPoint: mid.status === "fulfilled" ? `${mid.value.tempPoint} 기온 / ${mid.value.landRegion} 육상` : undefined,
          days: [...shortDays.map((d) => ({ ...d, source: "단기" })), ...midDays.map((d) => ({ ...d, source: "중기" }))],
          errors: errors.length ? errors : undefined,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_crowd_forecast",
    {
      title: "관광지 혼잡도 예측",
      description:
        "한국관광공사 집중률 예측(향후 30일)으로 언제 덜 붐비는지 알려준다. attraction 없이 부르면 그 시군구의 날짜별 혼잡 추세(관광지 중앙값)와 관광지 이름 목록을, attraction을 주면 그 관광지의 날짜별 값을 준다. 값은 관광지별 상대 지수라 서로 다른 관광지끼리는 비교하지 말 것.",
      inputSchema: z.object({
        location: location.describe("관광지나 지역 이름. 이 위치의 시군구를 조회한다"),
        attraction: z.string().optional().describe('관광지 이름 필터 (예: "쁘띠프랑스"). 지역 조회 결과의 목록에서 고르면 정확하다'),
        startDate: date.optional().describe("기간 시작 (YYYYMMDD)"),
        endDate: date.optional().describe("기간 끝 (YYYYMMDD)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ location, attraction, startDate, endDate }) => {
      try {
        const p = await kakao.geocode(env.KAKAO_REST_KEY, location);
        const region = await kakao.regionCode(env.KAKAO_REST_KEY, p.x, p.y);
        return ok(
          await crowdForecast(env.TOUR_API_KEY, { sido: region.sido, sigungu: region.sigungu, attraction, startDate, endDate }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  const schedule = (what: string, from: string, to: string) =>
    z.object({
      from: z.string().min(1).describe(`출발 ${what} (예: "${from}")`),
      to: z.string().min(1).describe(`도착 ${what} (예: "${to}")`),
      date: date.optional().describe("출발 날짜 (YYYYMMDD). 생략하면 오늘"),
      departAfter: hhmm.optional().describe('이 시각 이후 출발 (예: "09:00")'),
      departBefore: hhmm.optional().describe('이 시각 이전 출발 (예: "13:00")'),
      limit: z.number().int().min(1).max(100).default(20).describe("최대 편수 (출발 시각 순)"),
    });

  server.registerTool(
    "search_trains",
    {
      title: "열차 시간표",
      description: "KTX, ITX, 무궁화 등 열차 시간표와 성인 운임. 좌석 잔여와 예매는 지원하지 않는다 (코레일/SRT에서 직접).",
      inputSchema: schedule("역", "서울", "강릉"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to, date, departAfter, departBefore, limit }) => {
      try {
        return ok(await transport.trains({ apiKey: env.TOUR_API_KEY, kv: env.CACHE }, from, to, date ?? kstNow().date, { departAfter, departBefore, limit }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_express_buses",
    {
      title: "고속버스 시간표",
      description: "고속버스 시간표, 등급(일반/우등/프리미엄), 운임. 시간표는 오늘과 내일분만 제공된다. 좌석 잔여와 예매는 지원하지 않는다.",
      inputSchema: schedule("고속버스 터미널", "동서울", "강릉"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to, date, departAfter, departBefore, limit }) => {
      try {
        return ok(await transport.expressBuses({ apiKey: env.TOUR_API_KEY, kv: env.CACHE }, from, to, date ?? kstNow().date, { departAfter, departBefore, limit }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_domestic_flights",
    {
      title: "국내선 운항 시간표",
      description: "국내선 항공편 시간표와 기본 운임. 실시간 가격과 예매는 지원하지 않는다.",
      inputSchema: schedule("공항", "김포", "제주"),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ from, to, date, departAfter, departBefore, limit }) => {
      try {
        return ok(await transport.flights({ apiKey: env.TOUR_API_KEY, kv: env.CACHE }, from, to, date ?? kstNow().date, { departAfter, departBefore, limit }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

let handler: ReturnType<typeof createMcpHandler> | undefined;

const encoder = new TextEncoder();
/** Constant-time comparison so response timing doesn't leak how much of the token matched. */
function sameSecret(a: string, b: string) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.MCP_PATH_TOKEN || env.MCP_PATH_TOKEN.length < 16) {
      return new Response("MCP_PATH_TOKEN secret is missing or too short", { status: 500 });
    }
    const route = `/mcp/${env.MCP_PATH_TOKEN}`;
    if (!sameSecret(new URL(request.url).pathname, route)) {
      return new Response("Not found", { status: 404 });
    }
    handler ??= createMcpHandler(() => buildServer(env), { route });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

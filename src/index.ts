import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import * as kakao from "./kakao";
import * as tour from "./tourapi";

export interface Env {
  TOUR_API_KEY: string;
  KAKAO_REST_KEY: string;
  /** Secret path segment: the MCP endpoint is served at /mcp/<MCP_PATH_TOKEN>. */
  MCP_PATH_TOKEN: string;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
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
  .describe("광역 지역. 생략하면 전국");
const limit = z.number().int().min(1).max(30).default(10).describe("결과 개수");
const page = z.number().int().min(1).default(1).describe("페이지 번호");
const location = z.string().min(1).describe('장소명이나 주소 (예: "강릉역", "제주시 애월읍")');

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
    "get_place_detail",
    {
      title: "관광 정보 상세",
      description: "contentId로 개요, 홈페이지, 이용시간, 휴무일, 주차 등 상세 정보를 가져온다.",
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
        return ok(
          await tour.searchFestival(env.TOUR_API_KEY, {
            startDate,
            endDate,
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

  return server;
}

let handler: ReturnType<typeof createMcpHandler> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.MCP_PATH_TOKEN || env.MCP_PATH_TOKEN.length < 16) {
      return new Response("MCP_PATH_TOKEN secret is missing or too short", { status: 500 });
    }
    const route = `/mcp/${env.MCP_PATH_TOKEN}`;
    if (new URL(request.url).pathname !== route) {
      return new Response("Not found", { status: 404 });
    }
    handler ??= createMcpHandler(() => buildServer(env), { route });
    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

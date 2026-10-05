// 한국관광공사 관광지 집중률 방문자 추이 예측 (TatsCnctrRateService).
// https://www.data.go.kr/data/15128555/openapi.do
// 시군구 단위로 관광지별 향후 30일 집중률(0~100)을 준다.
//
// 집중률은 방문자 수가 아니라 관광지마다 따로 매긴 상대 지수다. 향나무의 90과 테마파크의 90은
// 둘 다 "그곳 기준으로 붐비는 날"일 뿐 서로 비교할 수 없다. 그래서 관광지끼리 순위를 매기지 않고,
// 지역 조회는 날짜별 중앙값(튀는 항목에 덜 흔들림)으로, 관광지 조회는 그 관광지의 날짜별 값으로 답한다.

import { callDataGoKr, lowerKeys } from "./datagokr";

const URL_ = "https://apis.data.go.kr/B551011/TatsCnctrRateService/tatsCnctrRatedList";
const MAX_NAMES = 40;
const PAGE_SIZE = 1000;
// 제주시 7320행(8페이지), 서귀포 6120행(7페이지)까지 확인. 요청당 외부 호출 50번 한도 안에서 여유를 둔다.
const MAX_PAGES = 10;

// 행정구역 개편으로 새 시군구 코드가 생겼지만 집중률 데이터는 아직 옛 코드로만 있는 곳.
// 인천(2026): 중구·동구 -> 제물포구(28125)·영종구(28155), 서구 -> 서해구(28275)·검단구(28290).
// 옛 중구는 원도심과 영종도를 함께 담고 있어 나눌 수 없으니 둘 다 옛 중구 전체로 답한다.
const LEGACY_SIGUNGU: Record<string, { codes: string[]; label: string }> = {
  "28125": { codes: ["28110", "28140"], label: "옛 인천 중구·동구" },
  "28155": { codes: ["28110"], label: "옛 인천 중구 (영종도와 원도심 포함)" },
  "28275": { codes: ["28260"], label: "옛 인천 서구" },
  "28290": { codes: ["28260"], label: "옛 인천 서구" },
};

type Day = { date: string; rate: number };

/** "20261008" + 18.9 -> "10/08 19" — compact so the answer stays small for the LLM. */
const fmt = (d: Day) => `${d.date.slice(4, 6)}/${d.date.slice(6, 8)} ${Math.round(d.rate)}`;

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(days: Day[]) {
  days.sort((a, b) => a.date.localeCompare(b.date));
  const byRate = [...days].sort((a, b) => a.rate - b.rate);
  return {
    quietest: byRate.slice(0, 3).map(fmt),
    busiest: byRate.slice(-3).reverse().map(fmt),
    daily: days.map(fmt),
  };
}

export async function crowdForecast(
  apiKey: string,
  opts: { sido: string; sigungu: string; attraction?: string; startDate?: string; endDate?: string },
) {
  // 한 페이지 최대 1000행 = 관광지 약 33곳 x 30일. 통영(2820행)처럼 큰 시군구는 여러 페이지라
  // 첫 페이지만 읽으면 가나다순 앞쪽 관광지만 보게 된다. 첫 페이지의 totalCount로 나머지를 병렬로 읽는다.
  const fetchDistrict = async (sigungu: string) => {
    const page = (pageNo: number) =>
      callDataGoKr(apiKey, URL_, {
        MobileOS: "ETC",
        MobileApp: "travel-mcp",
        _type: "json",
        numOfRows: PAGE_SIZE,
        pageNo,
        areaCd: opts.sido,
        signguCd: sigungu,
        tAtsNm: opts.attraction,
      });
    const first = await page(1);
    const pages = Math.min(MAX_PAGES, Math.ceil(first.totalCount / PAGE_SIZE));
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => page(i + 2)));
    return [first, ...rest].flatMap((p) => p.items);
  };
  let items = await fetchDistrict(opts.sigungu);
  const legacy = LEGACY_SIGUNGU[opts.sigungu];
  if (!items.length && legacy) items = (await Promise.all(legacy.codes.map(fetchDistrict))).flat();
  const rows = items
    .map(lowerKeys)
    .filter((r) => (!opts.startDate || String(r.baseymd) >= opts.startDate) && (!opts.endDate || String(r.baseymd) <= opts.endDate));

  const byPlace = new Map<string, Day[]>();
  const byDate = new Map<string, number[]>();
  for (const r of rows) {
    const name = String(r.tatsnm);
    const day = { date: String(r.baseymd), rate: Number(r.cnctrrate) };
    if (!byPlace.has(name)) byPlace.set(name, []);
    byPlace.get(name)!.push(day);
    if (!byDate.has(day.date)) byDate.set(day.date, []);
    byDate.get(day.date)!.push(day.rate);
  }
  if (!items.length) {
    return {
      sigunguCode: opts.sigungu,
      attractions: [],
      note: opts.attraction
        ? `"${opts.attraction}"과 일치하는 관광지가 없다. attraction 없이 다시 조회해 목록에서 이름을 고를 것.`
        : opts.sido === "12"
          ? "전남광주통합특별시(옛 광주·전남)는 통합 이후 한국관광공사 집중률 데이터가 갱신되지 않아 옛 코드와 새 코드 모두 비어 있다."
          : "이 시군구는 집중률 예측 데이터가 제공되지 않는다.",
    };
  }
  const district = legacy && items.length ? legacy.label : String(rows[0]?.signgunm ?? opts.sigungu);
  const note =
    "집중률은 방문자 수나 혼잡 퍼센트가 아니다. 각 관광지의 평소 대비 붐빔을 0~100으로 매긴 상대 지수로, 같은 장소의 날짜끼리만 비교할 수 있다. 값 형식은 'MM/DD 지수'.";

  if (opts.attraction) {
    return {
      district,
      note,
      attractions: [...byPlace.entries()].map(([name, days]) => ({ attraction: name, ...summarize(days) })),
    };
  }

  const names = [...byPlace.keys()].sort((a, b) => a.localeCompare(b, "ko"));
  return {
    district,
    note: `${note} 지역 값은 그날 이 시군구 관광지들의 중앙값이다. 특정 관광지는 attraction으로 다시 조회할 것.`,
    districtTrend: summarize([...byDate.entries()].map(([date, rates]) => ({ date, rate: median(rates) }))),
    attractionCount: names.length,
    attractions: names.length > MAX_NAMES ? [...names.slice(0, MAX_NAMES), `외 ${names.length - MAX_NAMES}곳`] : names,
  };
}

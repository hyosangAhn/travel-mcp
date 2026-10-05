// 한국관광공사 관광지 집중률 방문자 추이 예측 (TatsCnctrRateService).
// https://www.data.go.kr/data/15128555/openapi.do
// 시군구 단위로 관광지별 향후 30일 집중률(0~100, 높을수록 붐빔)을 준다.

import { callDataGoKr, lowerKeys } from "./datagokr";

const URL_ = "https://apis.data.go.kr/B551011/TatsCnctrRateService/tatsCnctrRatedList";

const round1 = (n: number) => Math.round(n * 10) / 10;
/** "20261008" + 18.9 -> "10/08 19" — compact so a district-wide answer stays small for the LLM. */
const fmt = (d: { date: string; rate: number }) => `${d.date.slice(4, 6)}/${d.date.slice(6, 8)} ${Math.round(d.rate)}`;

export async function crowdForecast(
  apiKey: string,
  opts: { sido: string; sigungu: string; attraction?: string; startDate?: string; endDate?: string; limit: number },
) {
  const { items } = await callDataGoKr(apiKey, URL_, {
    MobileOS: "ETC",
    MobileApp: "travel-mcp",
    _type: "json",
    numOfRows: 1000,
    pageNo: 1,
    areaCd: opts.sido,
    signguCd: opts.sigungu,
    tAtsNm: opts.attraction,
  });
  const rows = items
    .map(lowerKeys)
    .filter((r) => (!opts.startDate || String(r.baseymd) >= opts.startDate) && (!opts.endDate || String(r.baseymd) <= opts.endDate));

  const byPlace = new Map<string, { date: string; rate: number }[]>();
  for (const r of rows) {
    const name = String(r.tatsnm);
    if (!byPlace.has(name)) byPlace.set(name, []);
    byPlace.get(name)!.push({ date: String(r.baseymd), rate: Number(r.cnctrrate) });
  }

  // 기간 평균이 높은 순 = 그 기간에 사람이 몰리는 대표 관광지 순. 하위권에는 묘역·시설 같은 잡음 항목이 많아 limit으로 자른다.
  const places = [...byPlace.entries()]
    .map(([name, days]) => {
      days.sort((a, b) => a.date.localeCompare(b.date));
      const byRate = [...days].sort((a, b) => a.rate - b.rate);
      return {
        attraction: name,
        avgRate: round1(days.reduce((s, d) => s + d.rate, 0) / days.length),
        quietest: byRate.slice(0, 2).map(fmt),
        busiest: byRate.slice(-2).reverse().map(fmt),
        // 특정 관광지를 물었을 때만 일별 값을 준다.
        daily: opts.attraction ? days.map(fmt) : undefined,
      };
    })
    .sort((a, b) => b.avgRate - a.avgRate);

  return {
    district: String(rows[0]?.signgunm ?? opts.sigungu),
    period: rows.length ? `${opts.startDate ?? rows.map((r) => String(r.baseymd)).sort()[0]}~${opts.endDate ?? "+30일"}` : undefined,
    note: "집중률 0~100, 높을수록 붐빈다. 값 형식은 'MM/DD 집중률'. avgRate는 기간 평균이며 높은 순으로 정렬.",
    totalAttractions: places.length,
    places: places.slice(0, opts.limit),
  };
}

// 한국관광공사 관광지 집중률 방문자 추이 예측 (TatsCnctrRateService).
// https://www.data.go.kr/data/15128555/openapi.do
// 시군구 단위로 관광지별 향후 30일 집중률(0~100, 높을수록 붐빔)을 준다.

import { callDataGoKr, lowerKeys } from "./datagokr";

const URL_ = "https://apis.data.go.kr/B551011/TatsCnctrRateService/tatsCnctrRatedList";

export async function crowdForecast(
  apiKey: string,
  opts: { sido: string; sigungu: string; attraction?: string; startDate?: string; endDate?: string },
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
  const places = [...byPlace.entries()].map(([name, days]) => {
    days.sort((a, b) => a.date.localeCompare(b.date));
    const sorted = [...days].sort((a, b) => a.rate - b.rate);
    return {
      attraction: name,
      quietestDays: sorted.slice(0, 3),
      busiestDays: sorted.slice(-3).reverse(),
      // 시군구 전체 조회는 관광지 수 x 30일이라 너무 길다. 특정 관광지를 물었을 때만 일별 값을 준다.
      daily: opts.attraction ? days : undefined,
    };
  });
  return {
    district: String(rows[0]?.signgunm ?? opts.sigungu),
    note: "집중률은 0~100 지수. 높을수록 붐빈다 (이동통신 데이터 기반 예측).",
    places,
  };
}

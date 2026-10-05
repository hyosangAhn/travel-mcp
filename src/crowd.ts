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
  const district = String(rows[0]?.signgunm ?? opts.sigungu);
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

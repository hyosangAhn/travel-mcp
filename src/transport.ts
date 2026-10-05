// 국토교통부 TAGO 시간표 (열차, 고속버스, 국내선).
// TAGO는 2022년 서비스 개편 후 경로가 /1613000/TrainInfo/GetXxx 형태다 (옛 TrainInfoService 경로는 폐기됨).
// 시간표와 운임만 있고 좌석 잔여나 예매 기능은 없다.

import { callDataGoKr, lowerKeys, type Item } from "./datagokr";

const TAGO = "https://apis.data.go.kr/1613000";

async function tago(apiKey: string, path: string, params: Record<string, string | number | undefined>) {
  const { items } = await callDataGoKr(apiKey, `${TAGO}/${path}`, { _type: "json", numOfRows: 200, pageNo: 1, ...params });
  return items.map(lowerKeys);
}

const hm = (v: unknown) => {
  const s = String(v ?? ""); // YYYYMMDDHHMMSS or YYYYMMDDHHMM
  return s.length >= 12 ? `${s.slice(8, 10)}:${s.slice(10, 12)}` : s || undefined;
};
const won = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
const norm = (s: string) => s.replace(/\s|역$|터미널$|종합|고속|버스|공항$/g, "");

/** 출발 시각 범위와 개수 제한. 김포-제주처럼 하루 100편이 넘는 구간에서 응답을 줄인다. */
export type Window = { departAfter?: string; departBefore?: string; limit: number };

const toHm = (t: string) => {
  const d = t.replace(":", "").padStart(4, "0");
  return `${d.slice(0, 2)}:${d.slice(2, 4)}`;
};

/** Keep departures in [departAfter, departBefore] (inclusive, "HH:MM"), sorted, at most limit. */
function windowed<T extends { depart?: string }>(list: T[], w: Window) {
  const after = w.departAfter ? toHm(w.departAfter) : "00:00";
  const before = w.departBefore ? toHm(w.departBefore) : "99:99";
  const inRange = list
    .filter((x) => x.depart !== undefined && x.depart >= after && x.depart <= before)
    .sort((a, b) => String(a.depart).localeCompare(String(b.depart)));
  return {
    totalCount: list.length,
    matchedCount: inRange.length,
    truncated: inRange.length > w.limit ? `출발 시각 순 앞 ${w.limit}개만 표시. departAfter로 뒤 시간대를 볼 수 있다.` : undefined,
    items: inRange.slice(0, w.limit),
  };
}

/** Expose windowed items under a tool-specific key (trains / buses / flights). */
function rename<R extends { items: unknown[] }>(r: R, key: string) {
  const { items, ...rest } = r;
  return { ...rest, [key]: items };
}

/** Pick the candidate whose name matches best: exact > startsWith > includes. */
function pick<T>(list: T[], name: (t: T) => string, query: string): T | undefined {
  const q = norm(query);
  return (
    list.find((t) => norm(name(t)) === q) ??
    list.find((t) => norm(name(t)).startsWith(q)) ??
    list.find((t) => norm(name(t)).includes(q))
  );
}

// ---------- 열차 ----------

// 역 목록은 거의 바뀌지 않으니 isolate 수명 동안 캐시한다 (시도 수만큼 호출이 필요해서).
let stationCache: Promise<Item[]> | undefined;
function allStations(apiKey: string) {
  stationCache ??= (async () => {
    const cities = await tago(apiKey, "TrainInfo/GetCtyCodeList", {});
    const lists = await Promise.all(
      cities.map((c) => tago(apiKey, "TrainInfo/GetCtyAcctoTrainSttnList", { cityCode: c.citycode, numOfRows: 500 })),
    );
    return lists.flat();
  })().catch((e) => {
    stationCache = undefined;
    throw e;
  });
  return stationCache;
}

async function station(apiKey: string, query: string) {
  const s = pick(await allStations(apiKey), (t) => String(t.nodename), query);
  if (!s) throw new Error(`기차역을 찾을 수 없음: "${query}"`);
  return { id: String(s.nodeid), name: String(s.nodename) };
}

export async function trains(apiKey: string, from: string, to: string, date: string, w: Window) {
  const [dep, arr] = await Promise.all([station(apiKey, from), station(apiKey, to)]);
  const rows = await tago(apiKey, "TrainInfo/GetStrtpntAlocFndTrainInfo", {
    depPlaceId: dep.id,
    arrPlaceId: arr.id,
    depPlandTime: date,
    numOfRows: 300,
  });
  return {
    from: dep.name,
    to: arr.name,
    date,
    ...rename(
      windowed(
        rows.map((r) => ({
          grade: r.traingradename,
          trainNo: r.trainno,
          depart: hm(r.depplandtime),
          arrive: hm(r.arrplandtime),
          adultFareKrw: won(r.adultcharge),
        })),
        w,
      ),
      "trains",
    ),
  };
}

// ---------- 고속버스 ----------

// 같은 터미널이 여러 ID로 등록돼 있고(예: 동서울 NAEK030~035) 노선마다 붙은 ID가 다르다.
async function terminal(apiKey: string, query: string) {
  const list = await tago(apiKey, "ExpBusInfo/GetExpBusTrminlList", { terminalNm: norm(query) || query });
  const t = pick(list, (x) => String(x.terminalnm), query) ?? list[0];
  if (!t) throw new Error(`고속버스 터미널을 찾을 수 없음: "${query}"`);
  const name = String(t.terminalnm);
  return { ids: list.filter((x) => String(x.terminalnm) === name).map((x) => String(x.terminalid)), name };
}

export async function expressBuses(apiKey: string, from: string, to: string, date: string, w: Window) {
  const [dep, arr] = await Promise.all([terminal(apiKey, from), terminal(apiKey, to)]);
  const pairs = dep.ids.flatMap((d) => arr.ids.map((a) => [d, a]));
  const rows = (
    await Promise.all(
      pairs.map(([d, a]) =>
        tago(apiKey, "ExpBusInfo/GetStrtpntAlocFndExpbusInfo", {
          depTerminalId: d,
          arrTerminalId: a,
          depPlandTime: date,
          numOfRows: 300,
        }),
      ),
    )
  )
    .flat()
    .sort((x, y) => String(x.depplandtime).localeCompare(String(y.depplandtime)));
  return {
    from: dep.name,
    to: arr.name,
    date,
    // TAGO 고속버스 시간표는 오늘과 내일 것만 올라온다. 배차는 요일별로 거의 같아 가까운 날짜로 대신 볼 수 있다.
    note: rows.length ? undefined : "고속버스 시간표는 오늘~내일분만 제공된다. 그 이후 날짜는 내일 날짜로 조회해 참고할 것.",
    ...rename(
      windowed(
        rows.map((r) => ({
          grade: r.gradenm,
          depart: hm(r.depplandtime),
          arrive: hm(r.arrplandtime),
          fareKrw: won(r.charge),
        })),
        w,
      ),
      "buses",
    ),
  };
}

// ---------- 국내선 ----------

let airportCache: Promise<Item[]> | undefined;
async function airport(apiKey: string, query: string) {
  airportCache ??= tago(apiKey, "DmstcFlightNvgInfo/GetArprtList", {}).catch((e) => {
    airportCache = undefined;
    throw e;
  });
  const a = pick(await airportCache, (x) => String(x.airportnm), query);
  if (!a) throw new Error(`공항을 찾을 수 없음: "${query}"`);
  return { id: String(a.airportid), name: String(a.airportnm) };
}

export async function flights(apiKey: string, from: string, to: string, date: string, w: Window) {
  const [dep, arr] = await Promise.all([airport(apiKey, from), airport(apiKey, to)]);
  const rows = await tago(apiKey, "DmstcFlightNvgInfo/GetFlightOpratInfoList", {
    depAirportId: dep.id,
    arrAirportId: arr.id,
    depPlandTime: date,
    numOfRows: 300,
  });
  return {
    from: dep.name,
    to: arr.name,
    date,
    ...rename(
      windowed(
        rows.map((r) => ({
          airline: r.airlinenm,
          flightNo: r.vihicleid,
          depart: hm(r.depplandtime),
          arrive: hm(r.arrplandtime),
          economyFareKrw: won(r.economycharge),
          prestigeFareKrw: won(r.prestigecharge),
        })),
        w,
      ),
      "flights",
    ),
  };
}

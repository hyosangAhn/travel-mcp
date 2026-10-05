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

export async function trains(apiKey: string, from: string, to: string, date: string) {
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
    count: rows.length,
    trains: rows.map((r) => ({
      grade: r.traingradename,
      trainNo: r.trainno,
      depart: hm(r.depplandtime),
      arrive: hm(r.arrplandtime),
      adultFareKrw: won(r.adultcharge),
    })),
  };
}

// ---------- 고속버스 ----------

async function terminal(apiKey: string, query: string) {
  const list = await tago(apiKey, "ExpBusInfo/GetExpBusTrminlList", { terminalNm: norm(query) || query });
  const t = pick(list, (x) => String(x.terminalnm), query) ?? list[0];
  if (!t) throw new Error(`고속버스 터미널을 찾을 수 없음: "${query}"`);
  return { id: String(t.terminalid), name: String(t.terminalnm) };
}

export async function expressBuses(apiKey: string, from: string, to: string, date: string) {
  const [dep, arr] = await Promise.all([terminal(apiKey, from), terminal(apiKey, to)]);
  const rows = await tago(apiKey, "ExpBusInfo/GetStrtpntAlocFndExpbusInfo", {
    depTerminalId: dep.id,
    arrTerminalId: arr.id,
    depPlandTime: date,
    numOfRows: 300,
  });
  return {
    from: dep.name,
    to: arr.name,
    date,
    count: rows.length,
    buses: rows.map((r) => ({
      grade: r.gradenm,
      depart: hm(r.depplandtime),
      arrive: hm(r.arrplandtime),
      fareKrw: won(r.charge),
    })),
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

export async function flights(apiKey: string, from: string, to: string, date: string) {
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
    count: rows.length,
    flights: rows.map((r) => ({
      airline: r.airlinenm,
      flightNo: r.vihicleid,
      depart: hm(r.depplandtime),
      arrive: hm(r.arrplandtime),
      economyFareKrw: won(r.economycharge),
      prestigeFareKrw: won(r.prestigecharge),
    })),
  };
}

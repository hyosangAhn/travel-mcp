// 기상청 단기예보 (VilageFcstInfoService_2.0) + 중기예보 (MidFcstInfoService).
// 단기: https://www.data.go.kr/data/15084084/openapi.do  — 격자(nx, ny) 기준, 약 3일
// 중기: https://www.data.go.kr/data/15059468/openapi.do  — 예보구역(regId) 기준, 10일까지

import { callDataGoKr, kstNow, type Item } from "./datagokr";

const SHORT = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";
const MID_LAND = "https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst";
const MID_TA = "https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa";

/** 위경도 → 기상청 격자 (Lambert Conformal Conic, 기상청 공식 변환식). */
export function toGrid(lon: number, lat: number) {
  const RE = 6371.00877 / 5.0; // 지구 반경 / 격자 간격(km)
  const DEG = Math.PI / 180;
  const slat1 = 30 * DEG, slat2 = 60 * DEG, olon = 126 * DEG, olat = 38 * DEG;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (RE * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEG * 0.5);
  ra = (RE * sf) / Math.pow(ra, sn);
  let theta = lon * DEG - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + 43 + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + 136 + 0.5) };
}

/** 단기예보 발표시각: 02,05,...,23시. 발표 후 10분부터 조회 가능. */
function shortBase() {
  const { date, hhmm } = kstNow(-10);
  const h = Math.floor(Number(hhmm) / 100);
  const slots = [2, 5, 8, 11, 14, 17, 20, 23].filter((s) => s <= h);
  if (slots.length) return { base_date: date, base_time: `${String(slots.at(-1)).padStart(2, "0")}00` };
  return { base_date: kstNow(-10 - 24 * 60).date, base_time: "2300" };
}

/** 중기예보 발표시각: 06시, 18시. 여유를 두고 30분 뒤부터 쓴다. */
function midBase() {
  const { date, hhmm } = kstNow(-30);
  const h = Number(hhmm) / 100;
  if (h >= 18) return `${date}1800`;
  if (h >= 6) return `${date}0600`;
  return `${kstNow(-30 - 24 * 60).date}1800`;
}

const SKY: Record<string, string> = { "1": "맑음", "3": "구름많음", "4": "흐림" };
const PTY: Record<string, string> = { "1": "비", "2": "비/눈", "3": "눈", "4": "소나기" };

function condition(rows: Item[]) {
  // 강수 형태가 하나라도 있으면 그걸, 아니면 가장 흐린 하늘 상태를 보여준다.
  const pty = rows.filter((r) => r.category === "PTY" && r.fcstValue !== "0").map((r) => String(r.fcstValue));
  if (pty.length) return PTY[pty.sort().at(-1)!] ?? "강수";
  const sky = rows.filter((r) => r.category === "SKY").map((r) => String(r.fcstValue));
  return sky.length ? SKY[sky.sort().at(-1)!] : undefined;
}

export async function shortTerm(apiKey: string, lon: number, lat: number) {
  const { nx, ny } = toGrid(lon, lat);
  const base = shortBase();
  const { items } = await callDataGoKr(apiKey, SHORT, { dataType: "JSON", numOfRows: 1500, pageNo: 1, ...base, nx, ny });

  const byDate = new Map<string, Item[]>();
  for (const it of items) {
    const d = String(it.fcstDate);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(it);
  }
  const num = (rows: Item[], cat: string) => rows.filter((r) => r.category === cat).map((r) => Number(r.fcstValue));
  const days = [...byDate.entries()].map(([date, rows]) => {
    const tmp = num(rows, "TMP");
    const am = rows.filter((r) => Number(r.fcstTime) >= 600 && Number(r.fcstTime) < 1200);
    const pm = rows.filter((r) => Number(r.fcstTime) >= 1200 && Number(r.fcstTime) < 1800);
    return {
      date,
      minTempC: num(rows, "TMN")[0] ?? (tmp.length ? Math.min(...tmp) : undefined),
      maxTempC: num(rows, "TMX")[0] ?? (tmp.length ? Math.max(...tmp) : undefined),
      maxRainProbPct: Math.max(0, ...num(rows, "POP")),
      am: condition(am),
      pm: condition(pm),
      // 발표 범위 끝자락 날은 몇 시간치만 있어 최저/최고가 왜곡된다. 중기예보가 있으면 그걸 쓴다.
      partial: tmp.length < 20,
    };
  });
  return { source: "단기예보", base: `${base.base_date} ${base.base_time}`, grid: { nx, ny }, days };
}

// 중기 육상예보 구역 (시도 법정동 코드 → regId). 강원은 영서/영동으로 나뉜다.
const YEONGDONG = new Set(["51150", "51170", "51190", "51210", "51230", "51820", "51830"]); // 강릉 동해 태백 속초 삼척 고성 양양
function landRegId(sido: string, sigungu: string) {
  if (["11", "28", "41"].includes(sido)) return "11B00000"; // 서울 인천 경기
  if (sido === "51") return YEONGDONG.has(sigungu) ? "11D20000" : "11D10000";
  if (["30", "36", "44"].includes(sido)) return "11C20000"; // 대전 세종 충남
  if (sido === "43") return "11C10000"; // 충북
  // 전남광주통합특별시(12). 옛 광주(29)·전남(46) 코드도 남겨둔다. 예보구역은 통합 전과 같은 11F20000이다.
  if (["12", "29", "46"].includes(sido)) return "11F20000";
  if (sido === "52") return "11F10000"; // 전북
  if (["27", "47"].includes(sido)) return "11H10000"; // 대구 경북
  if (["26", "31", "48"].includes(sido)) return "11H20000"; // 부산 울산 경남
  if (sido === "50") return "11G00000"; // 제주
  return undefined;
}

// 중기 기온예보 지점 (가장 가까운 도시를 쓴다).
const TA_POINTS: [string, string, number, number][] = [
  ["서울", "11B10101", 126.98, 37.57], ["인천", "11B20201", 126.71, 37.46], ["수원", "11B20601", 127.03, 37.26],
  ["파주", "11B20305", 126.78, 37.76], ["춘천", "11D10301", 127.73, 37.88], ["원주", "11D10401", 127.92, 37.34],
  ["강릉", "11D20501", 128.88, 37.75], ["속초", "11D20401", 128.59, 38.21], ["대전", "11C20401", 127.38, 36.35],
  ["세종", "11C20404", 127.29, 36.48], ["청주", "11C10301", 127.49, 36.64], ["서산", "11C20101", 126.45, 36.78],
  ["광주", "11F20501", 126.85, 35.16], ["목포", "21F20801", 126.39, 34.81], ["여수", "11F20401", 127.66, 34.76],
  ["전주", "11F10201", 127.15, 35.82], ["군산", "21F10501", 126.74, 35.97], ["대구", "11H10701", 128.6, 35.87],
  ["안동", "11H10501", 128.73, 36.57], ["포항", "11H10201", 129.34, 36.02], ["부산", "11H20201", 129.08, 35.18],
  ["울산", "11H20101", 129.31, 35.54], ["창원", "11H20301", 128.68, 35.23], ["진주", "11H20701", 128.11, 35.18],
  ["제주", "11G00201", 126.53, 33.5], ["서귀포", "11G00401", 126.56, 33.25],
  // 섬 지점. 없으면 울릉도는 포항, 백령도는 인천 기온을 쓰게 된다. 육상 예보는 각각 경북, 서울·인천·경기 구역을 따른다.
  ["울릉", "11E00101", 130.9, 37.48], ["백령도", "11A00101", 124.68, 37.97],
];
/** 기온 지점 코드 -> 육상 예보구역. 섬 지점(11E 울릉, 11A 백령)은 육상 예보가 따로 없어 본토 구역을 쓴다. */
function landFromTa(code: string) {
  const zone = code[2];
  if (zone === "E") return "11H10000";
  if (zone === "A" || zone === "B") return "11B00000";
  if (zone === "G") return "11G00000";
  return `11${zone}${code[3]}0000`;
}

function nearestTa(lon: number, lat: number) {
  return TA_POINTS.reduce((best, p) =>
    (p[2] - lon) ** 2 + (p[3] - lat) ** 2 < (best[2] - lon) ** 2 + (best[3] - lat) ** 2 ? p : best,
  );
}

export async function midTerm(apiKey: string, lon: number, lat: number, sido: string, sigungu: string) {
  const ta = nearestTa(lon, lat);
  // 시도 코드는 행정구역 개편으로 바뀐다 (예: 광주·전남 -> 12). 모르는 코드면 가장 가까운 기온 지점이 속한
  // 육상 예보구역을 쓴다. 지점 코드 3~4번째 글자가 구역이다 (11D20501 -> 11D20000, 21F20801 -> 11F20000).
  const regId = landRegId(sido, sigungu) ?? landFromTa(ta[1]);
  const tmFc = midBase();
  const [land, temp] = await Promise.all([
    callDataGoKr(apiKey, MID_LAND, { dataType: "JSON", numOfRows: 10, pageNo: 1, regId, tmFc }),
    callDataGoKr(apiKey, MID_TA, { dataType: "JSON", numOfRows: 10, pageNo: 1, regId: ta[1], tmFc }),
  ]);
  const l = land.items[0] ?? {};
  const t = temp.items[0] ?? {};

  // 필드 이름은 n일 뒤 기준 (wf4Am, rnSt8, taMin5 ...). 제공 범위가 바뀌어도 있는 것만 읽는다.
  const base = new Date(`${tmFc.slice(0, 4)}-${tmFc.slice(4, 6)}-${tmFc.slice(6, 8)}T00:00:00Z`);
  const days = [];
  for (let n = 3; n <= 10; n++) {
    const am = l[`wf${n}Am`] ?? l[`wf${n}`];
    const pm = l[`wf${n}Pm`] ?? l[`wf${n}`];
    if (am === undefined && t[`taMin${n}`] === undefined) continue;
    const d = new Date(base.getTime() + n * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const rain = [l[`rnSt${n}Am`], l[`rnSt${n}Pm`], l[`rnSt${n}`]].filter((v) => v !== undefined).map(Number);
    days.push({
      date: d,
      minTempC: t[`taMin${n}`] !== undefined ? Number(t[`taMin${n}`]) : undefined,
      maxTempC: t[`taMax${n}`] !== undefined ? Number(t[`taMax${n}`]) : undefined,
      maxRainProbPct: rain.length ? Math.max(...rain) : undefined,
      am,
      pm,
    });
  }
  return { source: "중기예보", base: tmFc, landRegion: regId, tempPoint: ta[0], days };
}

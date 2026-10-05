// Calls every tool once against a running server and reports pass/fail.
//   npm run smoke                                         -> http://localhost:8799 (npm run dev)
//   npm run smoke -- https://travel-mcp.<account>.workers.dev
// The path token is read from .dev.vars (MCP_PATH_TOKEN) and never printed.

import fs from "node:fs";

const base = (process.argv[2] ?? "http://localhost:8799").replace(/\/$/, "");
const token = fs.readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").match(/^MCP_PATH_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) {
  console.error("MCP_PATH_TOKEN not found in .dev.vars");
  process.exit(2);
}
const url = `${base}/mcp/${token}`;

const pad = (n) => String(n).padStart(2, "0");
const ymd = (offsetDays) => {
  const d = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000); // KST
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

async function rpc(method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result;
}

// [tool, args, check(result) -> short summary; throw to fail]
const cases = [
  ["search_places", { keyword: "경복궁", limit: 3 }, (o) => {
    if (o.places[0]?.title !== "경복궁") throw new Error(`first result is "${o.places[0]?.title}", expected exact match`);
    return `${o.totalCount}건, 1위 ${o.places[0].title}`;
  }],
  ["find_nearby_places", { location: "강릉역", contentType: "음식점", limit: 3 }, (o) => `${o.totalCount}건, 예: ${o.places[0]?.title}`],
  ["search_stays", { near: "강릉역", stayType: "한옥스테이", radiusM: 10000, limit: 3 }, (o) => `${o.totalCount}건, 예: ${o.stays[0]?.title}`],
  ["get_place_detail", { contentId: "126508" }, (o) => `${o.title}, overview ${o.overview?.length ?? 0}자`],
  ["search_festivals", { startDate: ymd(0), area: "서울", limit: 3 }, (o) => `${o.totalCount}건${o.cache ? `, cache ${o.cache}` : ""}`],
  ["search_local", { query: "카페", near: "경포해변", limit: 3 }, (o) => `${o.places.length}건, 예: ${o.places[0]?.name}`],
  ["get_route_time", { origin: "강릉역", destination: "경포해변" }, (o) => `${o.totalDistanceKm}km ${o.totalDurationMin}분`],
  ["get_weather_forecast", { location: "가평군" }, (o) => {
    if (o.location.address !== "경기 가평군") throw new Error(`resolved to ${o.location.address}`);
    return `${o.days.length}일치${o.errors ? `, 일부 실패: ${o.errors.join("; ")}` : ""}`;
  }],
  ["get_crowd_forecast", { location: "가평군", startDate: ymd(1), endDate: ymd(7) }, (o) => `${o.district}, 한산 ${o.districtTrend.quietest[0]}, 관광지 ${o.attractionCount}곳`],
  ["search_trains", { from: "서울", to: "강릉", date: ymd(1), limit: 5 }, (o) => `${o.matchedCount}/${o.totalCount}편`],
  ["search_express_buses", { from: "동서울", to: "강릉", date: ymd(1), limit: 5 }, (o) => `${o.matchedCount}/${o.totalCount}편`],
  ["search_domestic_flights", { from: "김포", to: "제주", date: ymd(1), departAfter: "09:00", departBefore: "11:00", limit: 5 }, (o) => `${o.matchedCount}/${o.totalCount}편`],
];

let failed = 0;
const list = await rpc("tools/list", {});
const names = new Set(list.tools.map((t) => t.name));
console.log(`${base}  tools: ${names.size}`);
for (const [name] of cases) if (!names.has(name)) (failed++, console.log(`❌ ${name}: not registered`));

for (const [name, args, check] of cases) {
  if (!names.has(name)) continue;
  const t0 = Date.now();
  try {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(text);
    console.log(`✅ ${name} (${Date.now() - t0}ms, ${text.length}자): ${check(JSON.parse(text))}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name} (${Date.now() - t0}ms): ${e.message}`);
  }
}
console.log(failed ? `\n${failed}개 실패` : "\n모두 통과");
process.exit(failed ? 1 : 0);

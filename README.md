# travel-mcp

한국관광공사 TourAPI, 카카오, 기상청, 국토교통부 TAGO API를 MCP 도구로 묶어 Cloudflare Workers에 원격 MCP 서버로 띄운다.
URL 하나로 claude.ai(웹, 모바일), Claude Desktop, Claude Code, ChatGPT(Developer Mode)에서 함께 쓸 수 있다.

## 도구

| 도구 | 출처 | 설명 |
|---|---|---|
| `search_places` | TourAPI | 키워드로 관광지, 음식점, 숙박 등을 검색 (지역, 유형 필터) |
| `find_nearby_places` | TourAPI + 카카오 | 장소명 주변 반경 내 관광 정보를 거리순으로 검색 |
| `search_stays` | TourAPI | 숙소 검색 (지역 또는 장소 주변, 한옥스테이·글램핑 등 14개 유형) |
| `get_place_detail` | TourAPI | 개요, 이용시간, 휴무일, 주차 등 상세 정보. 숙소면 객실별 비수기/성수기 요금 |
| `search_festivals` | TourAPI | 기간 내 축제와 행사 |
| `search_local` | 카카오 로컬 | 맛집, 카페, 주차장 등 일반 장소 검색 |
| `get_route_time` | 카카오모빌리티 | 자동차 이동 거리와 시간 (경유지 최대 5개, 구간별 시간) |
| `get_weather_forecast` | 기상청 | 날짜별 기온, 강수확률, 오전/오후 날씨 (단기 + 중기, 10일까지) |
| `get_crowd_forecast` | 한국관광공사 | 관광지 집중률 예측 (향후 30일, 붐비는 날/한산한 날) |
| `search_trains` | TAGO | 열차 시간표와 운임 (좌석 잔여·예매 없음) |
| `search_express_buses` | TAGO | 고속버스 시간표, 등급, 운임 |
| `search_domestic_flights` | TAGO | 국내선 운항 시간표와 기본 운임 |

예약 기능은 없다. 국내 숙박·교통 예약 플랫폼은 개인에게 공개된 API가 없다.

## 준비물

1. **TourAPI 키**: [data.go.kr 국문 관광정보 서비스](https://www.data.go.kr/data/15101578/openapi.do)에서 활용신청한다. 마이페이지에 있는 **Decoding 키**를 쓴다.
2. **카카오 REST API 키**: [Kakao Developers](https://developers.kakao.com)에서 앱을 만들고 REST API 키를 복사한다.
   - 카카오맵(로컬) API 사용 설정을 켠다.
   - 길찾기는 [카카오모빌리티 개발자센터](https://developers.kakaomobility.com)에서 같은 앱을 연결해야 한다.
3. **data.go.kr 추가 활용신청**: 같은 인증키로 아래 서비스를 각각 활용신청한다. 승인 후 1시간쯤 지나야 키가 동작한다.
   - [기상청_단기예보 조회서비스](https://www.data.go.kr/data/15084084/openapi.do), [기상청_중기예보 조회서비스](https://www.data.go.kr/data/15059468/openapi.do)
   - [TAGO 열차정보](https://www.data.go.kr/data/15098552/openapi.do), [TAGO 고속버스정보](https://www.data.go.kr/data/15098522/openapi.do), [TAGO 국내항공운항정보](https://www.data.go.kr/data/15098526/openapi.do)
   - [한국관광공사_관광지 집중률 방문자 추이 예측 정보](https://www.data.go.kr/data/15128555/openapi.do)
4. **Cloudflare 계정**: 무료 플랜이면 충분하다.

## 로컬 실행

프로젝트 루트에 `.dev.vars` 파일을 만들고 키를 넣는다 (gitignore 대상이라 커밋되지 않는다).

```
TOUR_API_KEY=<data.go.kr Decoding 키>
KAKAO_REST_KEY=<카카오 REST API 키>
MCP_PATH_TOKEN=<16자 이상 랜덤 문자열>
```

```bash
npm install
npm run dev   # http://localhost:8799/mcp/<MCP_PATH_TOKEN>
```

도구 12개를 한 번씩 호출해 보는 스모크 테스트 (토큰은 `.dev.vars`에서 읽고 출력하지 않는다):

```bash
npm run smoke                                          # 로컬 (npm run dev 실행 중)
npm run smoke -- https://travel-mcp.<계정>.workers.dev   # 배포된 서버
```

[MCP Inspector](https://github.com/modelcontextprotocol/inspector)로도 테스트할 수 있다: `npx @modelcontextprotocol/inspector`
(Transport: Streamable HTTP, URL: 위 주소)

## 배포

### GitHub 연동 (Workers Builds)

1. 이 저장소를 GitHub에 push한다.
2. Cloudflare 대시보드에서 **Workers & Pages > Create > Import a repository**로 가서 저장소를 연결한다.
   - Build command는 비워두고, Deploy command는 `npx wrangler deploy`(기본값)로 둔다.
3. 첫 배포가 끝나면 Worker의 **Settings > Variables and Secrets**에서 `TOUR_API_KEY`, `KAKAO_REST_KEY`, `MCP_PATH_TOKEN`을 **Secret** 타입으로 추가한다.
4. 이후 `main`에 push할 때마다 자동으로 배포된다.

### CLI로 직접 배포

```bash
npx wrangler login
npx wrangler secret put TOUR_API_KEY
npx wrangler secret put KAKAO_REST_KEY
npx wrangler secret put MCP_PATH_TOKEN   # 아래 명령으로 만든 랜덤 값을 붙여넣는다
npm run deploy
```

랜덤 토큰 생성:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

배포가 끝나면 엔드포인트는 다음과 같다.

```
https://travel-mcp.<계정>.workers.dev/mcp/<MCP_PATH_TOKEN>
```

## 연결

- **claude.ai** (웹, 모바일 공통): 설정 > 커넥터 > 커스텀 커넥터 추가에서 위 URL을 넣는다.
- **ChatGPT**: 설정 > 앱 > 고급 설정에서 Developer Mode를 켠다. 앱을 만들 때 위 URL을 넣고 인증은 "없음"으로 둔다.
- **Claude Code**: `claude mcp add --transport http travel <URL>`
- **Claude Desktop**: claude.ai와 같은 커스텀 커넥터 설정을 쓴다.

## 보안 메모

- 인증은 URL 경로의 비밀 토큰 하나뿐이다. URL이 유출되면 누구나 API 쿼터를 쓸 수 있으니 공유하지 않는다.
  유출됐다면 `wrangler secret put MCP_PATH_TOKEN`으로 바꾸고 각 클라이언트의 URL을 갱신한다.
- 여러 사람이 쓰거나 더 강한 보호가 필요하면 Cloudflare `workers-oauth-provider`로 OAuth를 붙인다.
- 서버는 상태를 저장하지 않으며(stateless), Durable Object를 쓰지 않는다.

## 구조

```
src/index.ts    Worker 진입점, 경로 토큰 검사, MCP 도구 등록
src/tourapi.ts  TourAPI (KorService2) 클라이언트
src/kakao.ts    카카오 로컬, 지오코딩, 자동차 길찾기 클라이언트
```

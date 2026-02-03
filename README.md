# news-collector-viewer (EN)

A simple RSS-based news collector/viewer demo. The backend fetches and caches RSS, and the frontend renders a card-style UI by date/category.

## Structure
- `rss-card-viewer.html`: Frontend (mobile card UI)
- `backend/`: Node + Express backend

## How To Run
### 1) Start backend
```powershell
cd backend
npm install
npm start
```

### 2) Open frontend
- Open `rss-card-viewer.html` in your browser.
- By default, it calls `http://localhost:3000/api/feed`.

## API
- `GET /api/feed?cat=latest&date=YYYY-MM-DD`
  - Returns a snapshot by category and UTC date.
  - If `date` is omitted, returns the latest feed.

- `GET /api/backfill?cat=latest&days=7`
  - Creates snapshots for the last N days (UTC).

- `GET /api/health`
  - Health check

## Cache
- RSS and og:image are stored in memory and `backend/cache.json`.
- Cache is restored on server restart.

## Notes
- TechCrunch RSS often provides only the latest N items, so historical coverage may be limited.

---

# news-collector-viewer

간단한 RSS 기반 뉴스 수집/뷰어 데모입니다. 백엔드가 RSS를 가져와 캐시하고, 프론트는 날짜/카테고리 기준으로 카드형 UI로 보여줍니다.

## 구성
- `rss-card-viewer.html`: 프론트엔드(모바일 카드 UI)
- `backend/`: Node + Express 백엔드

## 실행 방법
### 1) 백엔드 실행
```powershell
cd backend
npm install
npm start
```

### 2) 프론트 열기
- `rss-card-viewer.html`을 브라우저에서 열면 됩니다.
- 기본적으로 백엔드는 `http://localhost:3000/api/feed`를 사용합니다.

## API
- `GET /api/feed?cat=latest&date=YYYY-MM-DD`
  - 카테고리와 UTC 날짜 기준 스냅샷을 반환합니다.
  - 날짜가 없으면 최신 피드를 반환합니다.

- `GET /api/backfill?cat=latest&days=7`
  - 최근 N일치 스냅샷을 생성합니다(UTC 기준).

- `GET /api/health`
  - 헬스 체크

## 캐시
- RSS와 og:image는 백엔드 메모리 + `backend/cache.json`에 저장됩니다.
- 서버 재시작 시 `cache.json`을 로드합니다.

## 참고
- TechCrunch RSS는 최근 N개만 제공되는 경우가 많아 과거 데이터가 제한될 수 있습니다.

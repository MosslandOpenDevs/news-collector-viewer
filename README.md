# news-collector-viewer

Weekly AI news card viewer with bilingual (KR/EN) rendering, ranked Top 10 curation, and backend-assisted feed/article processing.

## Overview

This project collects AI news from multiple sources, ranks items for weekly card output, and renders bilingual card pages.

Current primary page:

- `ai4.html` (KR/EN aligned Top 10 card view)

Backend responsibilities:

- Feed collection and normalization
- Article-body fetch for summary quality
- Summary/insight API integration

## Key Behaviors

- Strict KR/EN rank alignment:
  - Korean and English cards are rendered from the same ranked item pool.
  - Language toggle switches text only, not item order.
- Duplicate control:
  - Near-duplicate topics are deduplicated before final render.
  - Priority source handling is applied where configured.
- Editorial override layer:
  - Specific recurring stories can be pinned to consistent headline/summary pairs.
  - Used to keep KR/EN narrative matching stable item-by-item.
- Summary quality guardrails:
  - Placeholder/generic output is repaired with fallback logic.
  - Broken cards are prevented from silently corrupting ranking output.

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js, Express
- Parsing: `fast-xml-parser`, `cheerio`
- HTTP: `node-fetch`, `cors`

## Getting Started

## 1) Install dependencies

```powershell
cd backend
npm install
```

## 2) Start backend

```powershell
cd backend
npm start
```

Backend default URL:

- `http://localhost:3000`

## 3) Open frontend

Open one of the local pages in browser:

- `file:///.../ai4.html`

or serve from backend host if configured.

## Useful Endpoints

- `GET /api/feed`
- `GET /api/article-body`
- `GET|POST /api/summary`
- `GET|POST /api/insight`
- `GET /api/health`

## Dev Notes

- After editing card logic/content:
  1. Restart backend (`npm start` in `backend/`).
  2. Reopen `ai4.html` with cache-busting query (for example `?refresh=<timestamp>`).
- Keep KR/EN output aligned by rank and article mapping before publishing.

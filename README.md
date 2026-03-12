# news-collector-viewer

AI 뉴스 소스를 수집해 주간 카드형 랭킹으로 보여주는 뷰어입니다. 백엔드는 피드 수집과 캐시를 담당하고, 프런트는 `ai2.html` 기준으로 주간 HOT 15 카드를 렌더링합니다.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)

## Overview

이 프로젝트는 여러 AI 뉴스/블로그 소스를 모아 우선순위 기반으로 주간 카드 뉴스를 구성합니다. 현재 메인 화면은 `ai2.html`이며, `AI Times`와 `TechCrunch`를 가장 높은 우선순위로 두고 나머지 소스를 뒤에 배치합니다. 백엔드는 RSS와 HTML 파서를 함께 사용해 기사를 수집하고, 일부 소스는 기사 본문까지 추가로 읽어 카드 문구 품질을 보강합니다. 요약과 `Dev Insight`는 기본 소스 텍스트로 동작하고, 필요하면 OpenAI 또는 Gemini를 붙여 AI 생성으로 확장할 수 있습니다.

## Features

- 주간 카드 랭킹: 우선순위가 적용된 소스 기준으로 `Weekly AI Hot 15` 카드를 구성합니다.
- 소스 우선순위: `AI Times`와 `TechCrunch`를 최우선으로 두고, 그 뒤에 The Rundown AI, Superhuman, The Decoder, TLDR AI, MIT Technology Review AI 등을 반영합니다.
- 본문 보강: `AI Times`와 `TechCrunch`는 기사 본문을 추가 수집해 카드 요약과 분석 품질을 높입니다.
- AI 요약/인사이트: `/api/summary`, `/api/insight`를 통해 OpenAI 또는 Gemini 기반 문구 생성을 선택할 수 있습니다.
- 다국어 카드 뷰: 카드 텍스트와 하단 안내 문구를 한국어/영어 토글로 전환할 수 있습니다.
- 선택형 소스 제어: 화면에서 소스를 포함하거나 제외해 카드 후보군을 조정할 수 있습니다.

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js, Express
- Parsing: fast-xml-parser, Cheerio
- HTTP: node-fetch, CORS
- AI Providers: OpenAI Responses API, Google Gemini API

## Getting Started

Node.js가 설치되어 있어야 합니다.

### 1. Install dependencies

```powershell
cd backend
npm install
```

### 2. Configure environment variables

AI 요약과 `Dev Insight`를 사용할 경우에만 `.env`를 설정하면 됩니다. AI 기능을 쓰지 않아도 기본 카드 뷰와 소스 요약은 동작합니다.

```env
INSIGHT_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_INSIGHT_MODEL=gemini-2.5-flash
GEMINI_SUMMARY_MODEL=gemini-2.5-flash
```

OpenAI를 사용할 경우에는 아래 항목을 대신 설정할 수 있습니다.

```env
INSIGHT_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
OPENAI_INSIGHT_MODEL=gpt-5-mini
OPENAI_SUMMARY_MODEL=gpt-5-mini
```

### 3. Start backend

```powershell
cd backend
npm start
```

기본 포트는 `http://localhost:3000`입니다.

### 4. Open frontend

브라우저에서 `ai2.html`을 열면 됩니다. 프런트는 기본적으로 아래 엔드포인트를 사용합니다.

- `GET /api/feed`
- `GET /api/article-body`
- `GET|POST /api/summary`
- `GET|POST /api/insight`
- `GET /api/health`

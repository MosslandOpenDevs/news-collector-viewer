# news-collector-viewer

AI Times와 TechCrunch 기사를 기반으로 주간 AI HOT 카드뉴스를 만드는 뷰어입니다.  
현재 업데이트 버전의 기준 화면은 `ai6.html`이며, 한국어/영어 카드 표시와 Medium 업로드용 PNG 추출을 지원합니다.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Current Version](#current-version)
- [PNG Export](#png-export)
- [Backend API](#backend-api)
- [Publishing Checklist](#publishing-checklist)

## Overview

이 프로젝트는 AI 뉴스 원문을 수집하고, API 기반 요약과 번역을 거쳐 카드뉴스 형태로 보여주는 도구입니다.  
현재 운영 흐름은 AI Times를 우선 소스로 사용하고, 필요할 때 TechCrunch를 보조 소스로 사용할 수 있도록 구성되어 있습니다.

카드는 한국어와 영어가 같은 기사, 같은 순위, 같은 링크를 기준으로 매칭됩니다. 요약은 로컬 fallback 문구로 채우지 않고, 기사 원문을 API로 요약한 결과만 사용합니다. API 요약이 실패한 카드는 표시하지 않거나 다른 기사로 대체하는 것을 원칙으로 합니다.

## Features

- `ai6.html` 기준 AI HOT TOP 5 카드 뷰어
- 한국어/영어 카드 1:1 매칭
- AI Times 우선, TechCrunch 보조 소스 지원
- 기사 원문 기반 API 요약 및 번역
- fallback 요약 비사용 정책
- 출시, 도입, 공개, 논란, 등장성 기사 우선 선별
- 브리핑, 칼럼성 기사 제외
- 영어 카드용 자연스러운 에디토리얼 문체 보정
- 고유명사 정규화: `Cirrascale`, `OpenClaw`, `ClawSweeper`, `Anthropic`, `Claude Opus 4.6`, `Google DeepMind`, `ChatGPT`, `Codex`
- 숫자 표기 정규화: `4, 000` 대신 `4,000`
- 현재 카드 수에 맞춘 `HOT 5` 푸터 표시
- Medium 업로드용 썸네일/본문 PNG 추출
- HTML 하단 원문 링크 표시, PNG 추출 시 원문 링크 숨김

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- Backend: Node.js, Express
- Parsing: `fast-xml-parser`, `cheerio`
- HTTP: `node-fetch`, `cors`
- AI Summary: Groq 호환 Chat Completions API 중심
- PNG Export: Playwright, Pillow

## Getting Started

백엔드 의존성을 설치합니다.

```powershell
cd backend
npm install
```

필요 시 `backend/.env`에 API 키를 설정합니다.

```text
GROQ_API_KEY=...
GROQ_MODEL=...
```

백엔드를 실행합니다.

```powershell
cd backend
npm start
```

기본 주소는 `http://localhost:3000`입니다. 브라우저에서는 프로젝트 루트의 `ai6.html`을 열어 현재 카드 뷰어를 확인합니다.

## Current Version

현재 게시 기준 파일은 `ai6.html`입니다.

- Build: `2026-04-30-groq-throttle-r2`
- Rank Count: `AI HOT TOP 5`
- Primary Source: AI Times
- Secondary Source: TechCrunch
- Language Mode: Korean / English

현재 HOT 5는 아래 기사 ID를 기준으로 고정되어 한국어와 영어 카드가 같은 순서로 표시됩니다.

| Rank | Source | Article ID | Topic |
| --- | --- | --- | --- |
| 01 | AI Times | `209681` | GPT-5.5 |
| 02 | AI Times | `209678` | Cirrascale / Gemini |
| 03 | AI Times | `209762` | NVIDIA Korean virtual personas dataset |
| 04 | AI Times | `209851` | AI automation incident |
| 05 | AI Times | `209751` | ClawSweeper / OpenClaw |

## PNG Export

표준 영어 PNG를 생성합니다.

```powershell
python .\.agents\skills\ai4-png-export\scripts\export_ai4_png.py --html .\ai6.html --lang en --min-cards 5 --thumb-name ai6-en-thumbnail.png --body-name ai6-en-body.png
```

Medium 700px 기준으로 균형 조정된 PNG를 생성합니다.

```powershell
python .\.agents\skills\ai4-png-export\scripts\export_ai4_png.py --html .\ai6.html --lang en --min-cards 5 --content-width 700 --device-scale 1 --thumb-name ai6-en-thumbnail-700w-balanced.png --body-name ai6-en-body-medium-700w-balanced.png
```

최근 게시용 권장 출력 파일은 아래와 같습니다.

- `output/ai6-en-thumbnail-700w-balanced.png`
- `output/ai6-en-body-medium-700w-balanced.png`

PNG 추출 시 카드 사이 구분선은 유지하고, HTML 하단의 원문 링크 영역은 이미지에 포함하지 않습니다.

## Backend API

백엔드는 카드 렌더링에 필요한 기사 수집, 본문 추출, 요약, 번역을 담당합니다.

- `GET /api/health`: 서버 상태 확인
- `GET /api/feed`: 기사 목록 수집
- `GET /api/article-body`: 기사 본문 추출
- `POST /api/summary`: 기사 원문 요약
- `POST /api/translate`: 번역
- `POST /api/insight`: 보조 인사이트 생성

요약 API는 품질 유지를 위해 원문 기반 결과만 사용합니다. 공개 CORS 프록시가 불안정할 수 있으므로 안정적인 사용을 위해 로컬 백엔드를 실행한 상태에서 작업합니다.

## Publishing Checklist

- 백엔드가 `http://localhost:3000`에서 실행 중인지 확인
- `ai6.html`을 새로고침하여 HOT 5가 모두 표시되는지 확인
- 한국어/영어 카드의 순위와 원문 링크가 일치하는지 확인
- 영어 카드 제목과 요약이 직역체가 아닌지 확인
- 푸터의 `HOT 5` 표기가 현재 카드 수와 맞는지 확인
- HTML 하단에 원문 링크가 표시되는지 확인
- PNG에서는 원문 링크 영역이 제외되는지 확인
- Medium 업로드용 파일은 `output/ai6-en-body-medium-700w-balanced.png`를 우선 사용

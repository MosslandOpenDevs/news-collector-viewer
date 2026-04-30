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
- [Operating Principles](#operating-principles)
- [Project Philosophy](#project-philosophy)

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

## Operating Principles

이 섹션은 `ai6.html` 이후 버전에서 유지해야 할 카드 구성, 랭킹, 요약, 언어 정렬 원칙입니다. 현재 게시 버전은 HOT 5이지만, 운영 구조는 Top 10~15까지 확장 가능한 카드형 브리핑 뷰를 기준으로 설계합니다.

### Language Alignment

한국어와 영어는 서로 다른 기사 리스트를 만들지 않습니다. 동일한 랭킹 풀을 기준으로 언어별 제목과 요약만 전환하며, 토글 시 순위와 원문 링크가 바뀌면 안 됩니다.

KR/EN 카드는 동일 기사, 동일 의미, 유사한 정보 밀도를 유지해야 합니다. 한쪽 언어만 얇아지거나 다른 기사처럼 읽히는 카드는 최종 출력에서 허용하지 않습니다.

### Source Priority

AI Times를 기본 소스로 사용하고, TechCrunch는 보충용 소스로 사용합니다. 동일한 사건을 두 소스가 모두 다룰 경우 더 직접적이고 명확한 기사 1개만 대표 카드로 남깁니다.

이 구조는 국내 기사 기반의 안정적인 카드 구성을 유지하면서, 글로벌 주요 AI 이슈를 보완적으로 반영하기 위한 방식입니다.

### Ranking Priority

상단 카드에는 실제 제품과 기술 변화가 발생한 뉴스가 우선 배치됩니다.

- 제품 출시
- 모델 공개
- 공식 프리뷰
- 주요 기능 업데이트
- 서비스 롤아웃
- 기술 공개
- 공식 파트너십, 배포, 확장
- 주요 논란 또는 사고
- 새로운 기술·모델의 등장

특히 OpenAI/GPT, Anthropic/Claude, Google/Gemini, Meta, NVIDIA, Microsoft 관련 신규 모델, 기능, 업데이트는 상단 우선순위를 높게 둡니다.

반대로 칼럼, 해설, 오피니언, 추상적 산업 논평, 주관적 승패 분석 기사는 기본 우선순위를 낮춥니다.

### Deduplication

제목과 본문 토큰 유사도를 기준으로 근접 중복을 제거합니다. 동일 이슈의 복수 기사가 들어오면 소스 우선순위와 요약 품질을 반영해 대표 카드를 선택합니다.

렌더 직전에도 추가 중복 제거를 수행해 같은 이슈가 여러 카드로 반복 노출되지 않도록 합니다.

### Editorial Overrides

반복적으로 다뤄지는 핵심 이슈는 오버라이드 키로 고정 매칭할 수 있습니다.

오버라이드는 KR/EN 문구 품질을 안정화하고, 동일 이슈의 제목과 요약 톤을 유지하며, 순위별 기사-문구 매칭이 무너지는 문제를 막기 위해 사용합니다.

### Summary Format

카드 요약은 단순한 메모가 아니라 기사형 카드 브리핑이어야 합니다. 카드 한 장만 읽어도 핵심 내용을 이해할 수 있도록 2~3문장으로 구성합니다.

가능하면 각 요약에는 아래 정보가 포함되어야 합니다.

- 언제 공개, 출시, 업데이트됐는지
- 제품, 모델, 기능, 플랫폼, 기술이 무엇인지
- 핵심 기능 또는 변화가 무엇인지
- 어디에, 어떻게 쓰이는지
- 왜 중요한지 또는 어떤 영향을 가지는지

출시, 공개, 업데이트, 도입성 뉴스에는 이 구조를 적극 적용합니다. 다만 소스가 지원하지 않는 장점, 단점, 영향은 새로 만들지 않습니다.

### Source-Language Flow

번역 품질과 의미 일치를 위해 원문 언어 기준 생성 흐름을 고정합니다.

- AI Times 기사: 한국어 원문 → 한국어 요약 확정 → 영어 번역
- 해외 소스 기사: 영어 원문 → 영어 요약 확정 → 한국어 번역

이 원칙은 한국어와 영어 사이의 의미 드리프트를 줄이고, 한쪽 버전만 얇아지거나 이상하게 변형되는 문제를 줄이기 위한 기준입니다.

### Summary Quality Guardrails

최종 출력에서는 아래 유형의 카드를 허용하지 않습니다.

- 플레이스홀더 제목
- fallback 문장
- 잘린 요약
- 서로 다른 기사 조각이 섞인 요약
- 제목과 요약이 다른 기사를 설명하는 카드
- 명백한 오역
- 한국어와 영어가 섞인 카드

문제가 감지되면 기사 본문 기반 재요약, canonical summary 재활용, fallback 문구 제거, 후보 카드 교체를 순서대로 검토합니다.

### Filtering Balance

실시간 업데이트 환경에서는 필터가 지나치게 엄격하면 카드 수가 급감하거나 품질이 오히려 무너질 수 있습니다. 깨진 카드를 차단하는 규칙은 유지하되, 초기 후보 필터는 과도하게 좁히지 않습니다.

약한 카드는 즉시 제거하기보다 점수 페널티를 적용하고, 카드 수가 부족할 때만 보충 단계에서 제한적으로 완화합니다. 목표는 많이 걸러내는 것이 아니라 출력 품질을 유지하면서 안정적으로 카드 수를 채우는 것입니다.

### Card UI Readability

카드 품질은 문안뿐 아니라 시각적 가독성도 포함합니다.

- 소스 기반 이미지를 우선 사용
- 이미지는 텍스트를 방해하지 않도록 배치
- 이미지 맥락이 사라질 정도로 흐리게 처리하지 않음
- 텍스트 대비를 충분히 확보
- KR/EN 카드 모두 동일한 정보 구조 유지
- 순위 박스, 카테고리 라벨, 출처, 이미지 정렬 안정화

## Project Philosophy

이 프로젝트는 단순한 AI 뉴스 카드 생성기가 아니라, 실시간으로 갱신되더라도 품질이 무너지지 않는 AI 뉴스 브리핑 시스템을 지향합니다.

운영 목표는 많은 카드를 생성하는 것이 아니라 최신성, 정합성, 가독성, KR/EN 일치성, 카드형 요약 품질, 운영 안정성을 함께 만족하는 것입니다.

# Product Extractor App

`apps/product-extractor`는 Agentic GEO의 사용자 화면입니다. 상품 URL 또는 REST API 주소를 입력하고, AI provider와 RAG 프로필을 설정하며, 추출 결과를 JSON으로 확인하는 Next.js 앱입니다.

## 주요 기능

- 채팅형 입력창에서 상품 URL 또는 REST API 주소 입력
- 여러 소스를 한 번에 실행하는 큐/히스토리 UI
- OpenAI, Gemini, Azure OpenAI 연결 테스트와 모델 목록 확인
- REST API 요청 헤더와 소스 감지 방식 설정
- RAG 분석 프롬프트와 참고 문서 관리
- 진행 단계, 출력 요약, 출처를 보여주는 우측 패널
- 추출 결과 JSON 복사
- 기존 GEO RAW JSON 결과에 대한 수정 요청 처리
- 좁은 화면에서도 좌측/우측 패널이 자연스럽게 동작하는 반응형 UI

## 화면 구성

```txt
좌측 패널
  - 새 채팅
  - 히스토리 검색
  - 실행 기록
  - 설정

중앙 영역
  - 시작 안내
  - URL/REST API 입력창
  - 실행 대화와 결과 카드

우측 패널
  - 진행 상황
  - 출력 요약 또는 로그
  - 출처 목록
```

## 실행 방법

루트 디렉터리에서 실행하는 것을 권장합니다.

```bash
pnpm install
pnpm dev
```

앱 패키지만 직접 실행할 수도 있습니다.

```bash
pnpm --filter @agentic-geo/product-extractor dev
```

기본 주소:

```txt
http://localhost:3000
```

## 사용 흐름

1. 앱을 열고 좌측 하단 `설정`을 클릭합니다.
2. `AI 연동`에서 provider를 선택합니다.
3. API Key를 입력하고 모델 목록을 불러오거나 모델명을 입력합니다.
4. `연결 테스트` 또는 `저장 및 적용`을 실행합니다.
5. 입력창에 상품 URL 또는 REST API 주소를 넣습니다.
6. Enter 또는 전송 버튼으로 추출을 실행합니다.
7. 결과 카드나 우측 패널에서 JSON을 복사합니다.

## 입력 예시

상품 상세 페이지:

```txt
https://example.com/products/serum
```

여러 상품:

```txt
https://example.com/products/serum
https://example.com/products/cream
https://example.com/products/toner
```

REST API:

```txt
https://example.com/api/products/serum
```

## 설정 화면

### AI 연동

지원 provider:

- OpenAI
- Gemini
- Azure OpenAI

연결 테스트를 통과한 설정만 실제 추출 실행에 사용됩니다. 새로고침 직후에는 저장된 설정을 먼저 확인하고, 미연동 상태가 확정된 뒤에만 안내 배너를 표시합니다.

### REST API

REST API 입력 처리 방식을 설정합니다.

- 자동 감지
- 상품 URL
- REST API

필요하면 요청 헤더를 JSON 형식으로 입력할 수 있습니다.

```json
{
  "Authorization": "Bearer token",
  "Accept": "application/json"
}
```

### RAG 프로필

분석 프롬프트와 GEO 참고 파일을 관리합니다. 로컬 개발 서버에서는 `/api/rag-profile`을 통해 `packages/product-extractor-agent/src/rag` 파일과 동기화됩니다.

## API 라우트

| Route | Method | 역할 |
| --- | --- | --- |
| `/api/extract` | `POST` | 상품 URL/REST API 추출 실행 |
| `/api/provider/validate` | `POST` | AI provider 키와 모델 접근 확인 |
| `/api/rag-profile` | `GET` | 현재 RAG 프로필 읽기 |
| `/api/rag-profile` | `PUT` | RAG 프로필 저장 |
| `/api/rag-profile` | `DELETE` | RAG 프로필 기본값 복원 |

## 추출 API 요청 예시

```bash
curl -X POST http://localhost:3000/api/extract \
  -H "Content-Type: application/json" \
  -d '{
    "sources": ["https://example.com/products/serum"],
    "sourceType": "url",
    "llm": {
      "provider": "openai",
      "apiKey": "sk-...",
      "model": "gpt-..."
    }
  }'
```

응답은 성공 결과, 진단 로그, 실패 목록을 함께 반환합니다.

```json
{
  "results": [],
  "logs": [],
  "failures": []
}
```

## 환경 변수

서버 기본값으로 provider를 지정할 수 있습니다.

```env
AGENTIC_GEO_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=

AGENTIC_GEO_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=

AGENTIC_GEO_PROVIDER=azure-openai
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_DEPLOYMENT=
AZURE_OPENAI_API_VERSION=
```

정적 배포에서 외부 추출 API를 연결하려면 다음 값을 사용합니다.

```env
NEXT_PUBLIC_AGENTIC_GEO_API_URL=https://your-api.example.com
```

## 주요 파일

| 파일 | 설명 |
| --- | --- |
| `src/app/page.tsx` | 앱 첫 화면 |
| `src/app/components/ExtractorConsole.tsx` | 전체 콘솔 UI와 화면 상태 관리 |
| `src/app/globals.css` | 레이아웃, 패널, 입력창, 반응형 스타일 |
| `src/app/api/extract/route.ts` | 에이전트 REST 어댑터를 연결한 추출 API |
| `src/app/api/provider/validate/route.ts` | provider 연결 검증 API |
| `src/app/api/rag-profile/route.ts` | RAG 프로필 관리 API |

## 명령어

```bash
pnpm --filter @agentic-geo/product-extractor dev
pnpm --filter @agentic-geo/product-extractor lint
pnpm --filter @agentic-geo/product-extractor typecheck
pnpm --filter @agentic-geo/product-extractor build
pnpm --filter @agentic-geo/product-extractor build:pages
```

## 주의 사항

- 공개 정적 페이지에서는 개인 API Key 입력을 피하고, 별도 서버 API를 연결하는 방식을 권장합니다.
- RAG 파일 저장은 로컬/서버 파일 시스템에 접근 가능한 환경에서 동작합니다.
- GitHub Pages 정적 배포에서는 서버 API가 없으므로 실제 추출은 외부 API 연결이 필요합니다.

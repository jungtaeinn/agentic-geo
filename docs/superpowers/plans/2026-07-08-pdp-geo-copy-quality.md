# PDP GEO 생성 카피 품질 보강 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** copy-refiner의 LLM 추론으로 description의 분석 라벨/용량 파편을 제거하고, 거절 시 재정제(2차) 패스를 도입하며, FAQ를 GenAI 질문 의도 기반으로 재구성한다.

**Architecture:** 결정론적 생성(generate.ts)은 유지하고, `copy-refiner.ts`의 (1) 품질 게이트에 결정론적 검출기를 추가하되 수정은 LLM 재추론(2차 corrective pass)으로 수행, (2) FAQ 적용 계층을 답변 교체에서 질문 재작성+재정렬로 확장, (3) 프롬프트에 CEP 서사·용량 격리·네/아니요·GenAI 의도 규칙을 추가한다.

**Tech Stack:** TypeScript, vitest, pnpm 모노레포 (`packages/pdp-geo-generator-agent`)

**Spec:** `docs/superpowers/specs/2026-07-08-pdp-geo-copy-quality-design.md`

## Global Constraints

- 하드코딩 문자열 치환으로 공개 카피를 수정하지 않는다. 검출은 결정론적이어도 수정은 LLM 재추론으로 수행한다.
- 재정제(2차) LLM 호출은 최대 1회.
- FAQ 신규 질문 생성 금지: 모든 FAQ 항목은 `sourceQuestion`이 기존 질문과 매칭되어야 하며, 매칭 실패 항목은 드롭+경고.
- 새 숫자/성분/주장 미발생: 기존 `hasUnsupportedClaimTokens` 게이트를 모든 신규 채택 경로에 유지.
- 테스트 실행 명령: `pnpm --filter pdp-geo-generator-agent test` (프로젝트 루트에서), 단일 파일은 `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

- Modify: `packages/pdp-geo-generator-agent/src/types.ts` — 피드백/FAQ/요청 타입 확장
- Modify: `packages/pdp-geo-generator-agent/src/copy-refiner.ts` — 검출기, 거절 수집, 재정제 패스, FAQ 재구성, 프롬프트 규칙
- Modify: `packages/pdp-geo-generator-agent/src/agent.ts` — `inferredSearchQueries` 전달 (1줄)
- Create: `packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts` — 신규 단위 테스트
- Modify: `packages/pdp-geo-generator-agent/tests/generate-pdp-geo.test.ts` — 프롬프트 payload 검증 테스트 추가

---

### Task 1: 검출기 + description 게이트 + 구조화 거절 수집

description 필드(Web/Product/content)에서 분석 라벨(`평가 지표:` 등)과 raw 용량 문자열을 거절하는 게이트를 추가하고, 거절 내역을 구조화해 수집한다(재정제 패스의 입력).

**Files:**
- Modify: `packages/pdp-geo-generator-agent/src/types.ts` (PdpGeoCopyRefinementResult 근처, ~557행)
- Modify: `packages/pdp-geo-generator-agent/src/copy-refiner.ts` (`acceptRefinedText` ~872행, `applyCopyRefinement` ~735행)
- Test: `packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts` (신규)

**Interfaces:**
- Produces: `PdpGeoCopyRefinementFeedback { field, reason, rejectedText?, currentText? }` (types.ts export)
- Produces: `containsAnalysisLabelArtifact(text): boolean`, `containsRawVolumeFragment(text): boolean` (copy-refiner 내부 함수, Task 2에서 재사용)
- Produces: `applyCopyRefinement` 반환에 `rejections: PdpGeoCopyRefinementFeedback[]` 필드 추가 (Task 2가 소비)

- [ ] **Step 1: 테스트 파일 생성 + 실패 테스트 작성**

`packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts` 생성. 공용 픽스처 헬퍼와 게이트 테스트 2개를 작성한다.

```typescript
import { describe, expect, it } from "vitest";
import { refinePdpGeoCopy } from "../src/copy-refiner";
import type {
  PdpGeoCopyRefinementRequest,
  PdpGeoCopyRefinementResult,
  PdpGeoGeneratorOptions
} from "../src/types";

function createRefinementRequest(
  overrides: {
    productDescription?: string;
    webPageDescription?: string;
    faq?: Array<{ question: string; answer: string }>;
  } = {}
): PdpGeoCopyRefinementRequest {
  const productDescription = overrides.productDescription
    ?? "아토베리어365 캡슐 토너는 건조하고 민감한 피부를 위한 장벽보습 캡슐 토너입니다.";
  const webPageDescription = overrides.webPageDescription
    ?? "아토베리어365 캡슐 토너 상품 페이지는 민감 피부 고객을 위한 장벽보습 정보를 소개합니다.";
  const faq = overrides.faq ?? [
    {
      question: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
      answer: "아토베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐입니다."
    },
    {
      question: "에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
      answer: "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 적합한 장벽보습 캡슐 토너입니다."
    },
    {
      question: "에스트라 아토베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
      answer: "에스트라 아토베리어365 캡슐 토너는 PHA와 고밀도 세라마이드 캡슐을 담은 장벽보습 캡슐 토너입니다."
    }
  ];

  return {
    locale: "ko-KR",
    market: "KR",
    product: {
      name: "에스트라 아토베리어365 캡슐 토너",
      brand: "AESTURA",
      description: "세안 후 약해진 피부장벽을 강화하고 피부결을 정돈하는 장벽보습 캡슐 토너",
      images: [],
      options: [],
      benefits: ["장벽 보습", "수분감", "피부결 정돈"],
      effects: ["세정에 의한 장벽 손상은 사용 직후 93% 회복되었다."],
      ingredients: ["PHA", "고밀도 세라마이드 캡슐", "세라마이드 NP"],
      usage: ["캡슐을 부드럽게 녹이듯 골고루 펴 바른 후 가볍게 두드려 흡수시켜 줍니다."],
      metrics: ["세정에 의한 장벽 손상 93% 즉시 회복", "사용 직후 수분량 1.3배 증가"],
      faq,
      reviews: {
        keywords: ["장벽 보습", "촉촉한 사용감"],
        items: [{ body: "10.14 fl. oz. / 300 mL" }]
      },
      breadcrumbs: [],
      sourceTexts: [
        "세정에 의한 장벽 손상은 사용 직후 93% 즉시 회복.",
        "사용 직후 수분량 1.3배 증가.",
        "고밀도 세라마이드 캡슐이 장벽 보습을 돕는다.",
        "동일한 고밀도 세라마이드 캡슐이 아토베리어365 크림과 캡슐 토너에 사용된다."
      ]
    },
    schemaMarkup: {
      jsonLd: {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", description: webPageDescription },
          {
            "@type": "Product",
            description: productDescription,
            additionalProperty: [
              { "@type": "PropertyValue", name: "Reported details", value: "세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다." }
            ]
          },
          {
            "@type": "FAQPage",
            mainEntity: faq.map((item) => ({
              "@type": "Question",
              name: item.question,
              acceptedAnswer: { "@type": "Answer", text: item.answer }
            }))
          }
        ]
      },
      scriptTag: ""
    },
    content: {
      sections: {
        productName: "에스트라 아토베리어365 캡슐 토너",
        description: productDescription,
        quickFacts: "용량: 10.14 fl. oz. / 300 mL",
        benefits: "",
        ingredients: "",
        howToUse: "",
        faq: faq.map((item) => `Q. ${item.question}\nA. ${item.answer}`).join("\n\n")
      },
      html: ""
    },
    ragChunks: []
  };
}

function createOptions(refineCopy: (request: PdpGeoCopyRefinementRequest) => PdpGeoCopyRefinementResult | Promise<PdpGeoCopyRefinementResult>): PdpGeoGeneratorOptions {
  return { customCopyRefiner: { refineCopy } };
}

describe("copy refinement description gates", () => {
  it("rejects refined descriptions that expose analysis labels", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: {
        product: "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
      }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).not.toContain("평가 지표:");
    expect(result.warnings.some((warning) => warning.includes("Product.description") && warning.includes("analysis label"))).toBe(true);
  });

  it("rejects refined descriptions that enumerate raw volume strings", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      schemaDescriptions: {
        webPage: "아토베리어365 캡슐 토너 상품 페이지는 장벽 보습 맥락과 촉촉한 사용감 중심의 리뷰 맥락, 10.14 fl. oz. / 300 mL 용량을 함께 살펴볼 수 있습니다."
      }
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    expect(webPage.description).not.toContain("fl. oz.");
    expect(result.warnings.some((warning) => warning.includes("WebPage.description") && warning.includes("volume"))).toBe(true);
  });
});
```

참고: `PdpProductSignal`의 필수 필드가 위 픽스처와 다르면(예: `category`, `price`) 컴파일 에러에 맞춰 최소 필드를 채운다. `reviews.items`의 항목 형태는 기존 테스트(generate-pdp-geo.test.ts 2530행대)와 동일하게 맞춘다.

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`
Expected: FAIL — 현재 게이트가 없어 `평가 지표:` / `fl. oz.` 텍스트가 채택됨 (assertion 실패)

- [ ] **Step 3: types.ts에 피드백 타입 추가**

`packages/pdp-geo-generator-agent/src/types.ts`의 `PdpGeoCopyRefinementResult` 인터페이스 바로 위(~557행)에 추가:

```typescript
export interface PdpGeoCopyRefinementFeedback {
  field: string;
  reason: string;
  rejectedText?: string;
  currentText?: string;
}
```

- [ ] **Step 4: copy-refiner.ts에 검출기 + 게이트 + 거절 수집 구현**

(a) `copy-refiner.ts` 상단 import에 `PdpGeoCopyRefinementFeedback` 타입 추가.

(b) `acceptRefinedText` 함수 위(~865행)에 검출기 추가:

```typescript
const analysisLabelArtifactPattern = /(?:평가\s*지표|측정\/평가\s*결과|측정\s*결과|확인\s*지표|확인\s*근거|reported\s+results?|consumer\s+assessment|試験結果|確認指標)\s*[:：]/iu;

function containsAnalysisLabelArtifact(text: string): boolean {
  return analysisLabelArtifactPattern.test(text);
}

const rawVolumeFragmentPattern = /\d+(?:\.\d+)?\s*fl\.?\s*oz\.?|\/\s*\d+(?:\.\d+)?\s*m[lL]\b|\d+(?:\.\d+)?\s*m[lL]\s*용량/;

function containsRawVolumeFragment(text: string): boolean {
  return rawVolumeFragmentPattern.test(text);
}

function isDescriptionField(field: string): boolean {
  return field === "Product.description" || field === "WebPage.description" || field === "content.sections.description";
}
```

(c) `AcceptRefinedTextOptions`에 필드 추가:

```typescript
interface AcceptRefinedTextOptions {
  minLength?: number;
  maxLength?: number;
  evidenceCorpus?: string;
  requireSupportedClaimTokens?: boolean;
  rejections?: PdpGeoCopyRefinementFeedback[];
}
```

(d) `acceptRefinedText` 본문을 헬퍼 기반으로 리팩터: 함수 초입(`const text = cleanText(value);` 다음)에 헬퍼 정의를 추가하고, 기존의 모든 `warnings.push(\`${field} refinement rejected because ...\`); return undefined;` 쌍(약 25곳)을 `return reject("...");`로 치환한다(메시지 문자열은 동일하게 유지).

```typescript
  const reject = (reason: string): undefined => {
    warnings.push(`${field} refinement rejected because ${reason}`);
    options.rejections?.push({ field, reason, rejectedText: text });
    return undefined;
  };
```

예시 치환 (모든 분기 동일 패턴):

```typescript
  if (text.length < minLength) {
    return reject("it is too short.");
  }
```

(e) description 게이트 2개 추가 — 기존 `containsBrokenKoreanCopyFragment` 게이트(~977행) 바로 위에 삽입:

```typescript
  if (isDescriptionField(field) && containsAnalysisLabelArtifact(text)) {
    return reject("it exposes an internal analysis label such as 평가 지표: instead of a natural product sentence.");
  }
  if (isDescriptionField(field) && containsRawVolumeFragment(text)) {
    return reject("it lists raw volume/size strings that belong in quickFacts or Product.additionalProperty.");
  }
```

(f) `applyCopyRefinement`에서 rejections 수집·반환: 함수 시그니처의 반환 타입 Pick에 `"rejections"` 추가가 필요하므로 `CopyRefinementApplication`(17행)에 `rejections: PdpGeoCopyRefinementFeedback[];` 필드를 추가하고, `refinePdpGeoCopy`의 `baseApplication`에 `rejections: []`을 추가한다. `applyCopyRefinement` 함수 초입에 `const rejections: PdpGeoCopyRefinementFeedback[] = [];`를 선언하고, 함수 내 모든 `acceptRefinedText(...)` 호출의 options에 `rejections`를 추가하며(`{ evidenceCorpus: claimEvidenceCorpus, requireSupportedClaimTokens: true, rejections }` 형태), `acceptedSchemaPropertyRefinements`/`acceptedFaqAnswerRefinements` 호출에도 rejections 배열을 전달하도록 두 함수의 파라미터에 `rejections: PdpGeoCopyRefinementFeedback[]`를 추가하고 내부 `acceptRefinedText` options에 연결한다. 반환 객체에 `rejections`를 포함한다.

`refinePdpGeoCopy`의 반환 경로들(성공/에러)에서도 `rejections`를 채워 반환한다(에러 경로는 `rejections: []`).

- [ ] **Step 5: 테스트 실행 — 통과 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: 기존 테스트 회귀 확인**

Run: `pnpm --filter pdp-geo-generator-agent test`
Expected: 전체 PASS. `generate-pdp-geo.test.ts`의 기존 warning 문자열 assertion들이 `reject` 헬퍼 치환 후에도 동일 메시지를 생성하는지 확인(메시지 losslessness).

- [ ] **Step 7: 커밋**

```bash
git add packages/pdp-geo-generator-agent/src/types.ts packages/pdp-geo-generator-agent/src/copy-refiner.ts packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts
git commit -m "feat(pdp-geo): description 분석 라벨/용량 파편 게이트와 구조화 거절 수집 추가

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 거절-재정제(2차 corrective) 패스

1차 정제가 거절되거나 최종 채택 텍스트(폴백 포함)에 분석 라벨/용량 파편이 남으면, 거절 사유를 `refinementFeedback`으로 전달해 해당 필드만 재정제하는 2차 LLM 패스를 1회 실행한다.

**Files:**
- Modify: `packages/pdp-geo-generator-agent/src/types.ts` (PdpGeoCopyRefinementRequest ~545행)
- Modify: `packages/pdp-geo-generator-agent/src/copy-refiner.ts` (`refinePdpGeoCopy` 49행~, `createCopyRefinementPrompt` 421행~, `createCopyRefinementPayload` 497행~)
- Test: `packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts`

**Interfaces:**
- Consumes: Task 1의 `PdpGeoCopyRefinementFeedback`, `applyCopyRefinement(...).rejections`, `containsAnalysisLabelArtifact`, `containsRawVolumeFragment`
- Produces: `PdpGeoCopyRefinementRequest.refinementFeedback?: PdpGeoCopyRefinementFeedback[]` — payload의 `refinementFeedback` 키로 LLM에 노출

- [ ] **Step 1: 실패 테스트 작성**

`tests/copy-refiner.test.ts`에 추가:

```typescript
describe("corrective refinement pass", () => {
  it("retries rejected description refinement once with structured feedback", async () => {
    const request = createRefinementRequest();
    const cleanDescription = "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕고 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {
          schemaDescriptions: {
            product: "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
          },
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
        };
      }
      return {
        schemaDescriptions: { product: cleanDescription },
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 }
      };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1].refinementFeedback?.some((item) =>
      item.field === "Product.description" && item.reason.includes("analysis label")
    )).toBe(true);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(cleanDescription);
    expect(result.usage?.totalTokens).toBe(210);
  });

  it("triggers the corrective pass when unrefined fallback copy keeps analysis labels", async () => {
    const request = createRefinementRequest({
      productDescription: "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다."
    });
    const cleanDescription = "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객을 위한 장벽보습 캡슐 토너로, 세정에 의한 장벽 손상은 사용 직후 93% 회복되었습니다.";
    const calls: PdpGeoCopyRefinementRequest[] = [];

    const result = await refinePdpGeoCopy(request, createOptions((incoming) => {
      calls.push(incoming);
      if (calls.length === 1) {
        return {};
      }
      return { schemaDescriptions: { product: cleanDescription } };
    }));

    expect(calls).toHaveLength(2);
    expect(calls[1].refinementFeedback?.some((item) => item.field === "Product.description")).toBe(true);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(cleanDescription);
  });

  it("falls back with a warning when the corrective pass also fails", async () => {
    const badDescription = "에스트라 아토베리어365 캡슐 토너는 민감 피부용 캡슐 토너입니다. 사용 직후 시점 기준 평가 지표: 사용 직후는 93% 회복되었습니다.";
    const request = createRefinementRequest();
    let callCount = 0;

    const result = await refinePdpGeoCopy(request, createOptions(() => {
      callCount += 1;
      return { schemaDescriptions: { product: badDescription } };
    }));

    expect(callCount).toBe(2);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(product.description).toBe(request.content.sections.description);
    expect(result.warnings.some((warning) => warning.includes("corrective refinement pass"))).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`
Expected: FAIL — `calls` 길이 1 (재정제 패스 미구현), `refinementFeedback` undefined

- [ ] **Step 3: 타입 + 재정제 패스 구현**

(a) `types.ts`의 `PdpGeoCopyRefinementRequest`에 필드 추가:

```typescript
export interface PdpGeoCopyRefinementRequest {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  ragChunks: PdpGeoRetrievedChunk[];
  hydratedRagDocuments?: PdpGeoHydratedRagDocument[];
  reasoning?: PdpGeoReasoningResult;
  policyRules?: PdpGeoPolicyRule[];
  inferredSearchQueries?: PdpGeoInferredSearchQueryDiagnostic[];
  refinementFeedback?: PdpGeoCopyRefinementFeedback[];
}
```

(`inferredSearchQueries`는 Task 3에서 사용하지만 타입은 여기서 함께 추가)

(b) `copy-refiner.ts`에 재정제 유틸 추가 (`applyCopyRefinement` 위):

```typescript
function collectRetryTargets(
  applied: Pick<CopyRefinementApplication, "schemaMarkup" | "content" | "rejections">
): PdpGeoCopyRefinementFeedback[] {
  const feedback: PdpGeoCopyRefinementFeedback[] = [...applied.rejections];
  const descriptions = readSchemaDescriptions(applied.schemaMarkup.jsonLd);
  const finalTexts: Array<{ field: string; text?: string }> = [
    { field: "Product.description", text: descriptions.product },
    { field: "WebPage.description", text: descriptions.webPage },
    { field: "content.sections.description", text: applied.content.sections.description }
  ];
  for (const item of finalTexts) {
    if (!item.text) {
      continue;
    }
    if (containsAnalysisLabelArtifact(item.text)) {
      feedback.push({
        field: item.field,
        reason: "the current adopted text still exposes an internal analysis label such as 평가 지표:; rewrite the measured result as a natural product sentence with a supported predicate.",
        currentText: item.text
      });
    } else if (containsRawVolumeFragment(item.text)) {
      feedback.push({
        field: item.field,
        reason: "the current adopted text still lists a raw volume/size string; keep volume in quickFacts or Product.additionalProperty and restore a natural CEP sentence flow.",
        currentText: item.text
      });
    }
  }
  const seen = new Set<string>();
  return feedback.filter((item) => {
    if (seen.has(item.field)) {
      return false;
    }
    seen.add(item.field);
    return true;
  });
}

function mergeTokenUsage(
  first: PdpGeoTokenUsage | undefined,
  second: PdpGeoTokenUsage | undefined
): PdpGeoTokenUsage | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: sum(first.inputTokens, second.inputTokens),
    outputTokens: sum(first.outputTokens, second.outputTokens),
    totalTokens: sum(first.totalTokens, second.totalTokens)
  };
}
```

주의: `PdpGeoTokenUsage`의 실제 필드 구성을 types.ts에서 확인해 sum 대상 필드를 맞춘다.

(c) `refinePdpGeoCopy`의 try 블록을 재정제 패스 포함으로 수정. 기존 `const result = await resolved.refiner.refineCopy(request); const applied = applyCopyRefinement(request, result);` 구간(72–73행)을 다음으로 교체:

```typescript
    const result = await resolved.refiner.refineCopy(request);
    let applied = applyCopyRefinement(request, result);
    let usage = result.usage;
    let retryWarnings: string[] = [];
    const retryTargets = collectRetryTargets(applied);

    if (retryTargets.length > 0) {
      const retryRequest: PdpGeoCopyRefinementRequest = {
        ...request,
        schemaMarkup: applied.schemaMarkup,
        content: applied.content,
        refinementFeedback: retryTargets
      };
      try {
        const retryResult = await resolved.refiner.refineCopy(retryRequest);
        const retryApplied = applyCopyRefinement(retryRequest, retryResult);
        usage = mergeTokenUsage(usage, retryResult.usage);
        const remaining = collectRetryTargets(retryApplied);
        if (remaining.length > 0) {
          retryWarnings = [
            `Corrective refinement pass could not repair: ${remaining.map((item) => item.field).join(", ")} (corrective refinement pass exhausted).`
          ];
        }
        applied = {
          schemaMarkup: retryApplied.schemaMarkup,
          content: retryApplied.content,
          evidence: [
            ...applied.evidence,
            ...retryApplied.evidence,
            {
              field: "copy.refinement.retry",
              source: "llm",
              value: `Corrective refinement pass regenerated fields: ${retryTargets.map((item) => item.field).join(", ")}`
            }
          ],
          warnings: [...applied.warnings, ...retryApplied.warnings],
          rejections: retryApplied.rejections,
          applied: applied.applied || retryApplied.applied
        };
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : "Corrective refinement provider failed.";
        retryWarnings = [`Corrective refinement pass skipped: ${message}`];
      }
    }
```

이후 기존 `const warnings = [...(result.warnings ?? []), ...applied.warnings];`를 `const warnings = [...(result.warnings ?? []), ...applied.warnings, ...retryWarnings];`로, 반환의 `usage: result.usage`를 `usage`로 바꾼다. (참고: `applied`가 `let`이 되므로 이하 참조는 그대로 동작)

(d) `createCopyRefinementPrompt`의 system 배열 마지막에 corrective pass 지시 추가:

```typescript
      "When the user payload includes refinementFeedback, this is a corrective pass: regenerate ONLY the fields listed in refinementFeedback, fixing the stated rejection reason while keeping all other rules satisfied. Return empty strings or omit every field that is not listed in refinementFeedback.",
```

(e) `createCopyRefinementPayload` 반환 객체에 추가:

```typescript
    refinementFeedback: request.refinementFeedback?.map((item) => ({
      field: item.field,
      reason: item.reason,
      rejectedText: item.rejectedText ? truncate(cleanText(item.rejectedText), maxEvidenceTextChars) : undefined,
      currentText: item.currentText ? truncate(cleanText(item.currentText), maxEvidenceTextChars) : undefined
    })),
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`
Expected: PASS (Task 1 테스트 포함 전체)

주의: Task 1의 "rejects refined descriptions" 테스트 2개는 재정제 패스 도입 후 mock이 두 번 호출되어 두 번째도 같은 불량 텍스트를 반환 → 여전히 미채택 + 경고이므로 그대로 통과해야 한다. 통과하지 않으면 mock을 호출 횟수 무관하게 동일 반환하도록 유지한 채 assertion을 확인한다.

- [ ] **Step 5: 회귀 + 커밋**

Run: `pnpm --filter pdp-geo-generator-agent test`
Expected: 전체 PASS

```bash
git add packages/pdp-geo-generator-agent/src/types.ts packages/pdp-geo-generator-agent/src/copy-refiner.ts packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts
git commit -m "feat(pdp-geo): 거절 필드 재정제 corrective pass 추가 (라벨/용량 잔존 시 LLM 재추론)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: FAQ GenAI 의도 기반 재구성 (질문 재작성 + 재정렬 + 네/아니요)

refiner가 FAQ 전체를 최종 순서로 반환하고(`sourceQuestion` 매칭 필수), 적용 계층이 질문·답변 교체와 `FAQPage.mainEntity` 재배열을 수행한다. 프롬프트는 GenAI 질문 의도(`inferredSearchQueries`) 정렬, 추천 대상 질문 선행, 네/아니요 선행 답변을 지시한다.

**Files:**
- Modify: `packages/pdp-geo-generator-agent/src/types.ts` (~563행 faqAnswers)
- Modify: `packages/pdp-geo-generator-agent/src/agent.ts` (295행 refinePdpGeoCopy 호출)
- Modify: `packages/pdp-geo-generator-agent/src/copy-refiner.ts` (프롬프트 445행 규칙, `acceptedFaqAnswerRefinements` 1106행, `writeFaqAnswer` 1341행, `parseCopyRefinementJson` 1402행, `applyCopyRefinement` 827행)
- Test: `packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts`

**Interfaces:**
- Consumes: Task 2의 `request.inferredSearchQueries` 타입
- Produces: `PdpGeoCopyRefinementResult.faqAnswers: Array<{ sourceQuestion?: string; question?: string; answer?: string }>`
- Produces: `acceptedFaqRefinements(request, values, warnings, evidenceCorpus, rejections): { entries: Array<{ index: number; question: string; answer: string; beforeQuestion: string; beforeAnswer: string }>; order?: number[] } | undefined`
- Produces: `writeFaqEntries(schemaMarkup, entries, order?): PdpGeoSchemaMarkup`

- [ ] **Step 1: 실패 테스트 작성**

`tests/copy-refiner.test.ts`에 추가:

```typescript
describe("FAQ generative-intent recomposition", () => {
  it("reorders FAQ, rewrites questions, and applies yes-leading comparison answers", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      faqAnswers: [
        {
          sourceQuestion: "에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
          question: "민감하고 건조한 피부에는 어떤 토너를 추천하나요?",
          answer: "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 추천할 수 있는 장벽보습 캡슐 토너로, 고밀도 세라마이드 캡슐이 장벽 보습을 돕습니다."
        },
        {
          sourceQuestion: "에스트라 아토베리어365 캡슐 토너의 주요 성분과 효능은 무엇인가요?",
          question: "에스트라 아토베리어365 캡슐 토너에는 어떤 성분이 들어 있나요?",
          answer: "에스트라 아토베리어365 캡슐 토너는 PHA와 고밀도 세라마이드 캡슐을 담은 장벽보습 캡슐 토너로, 장벽 보습과 피부결 정돈을 돕습니다."
        },
        {
          sourceQuestion: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
          question: "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
          answer: "네, 동일한 고밀도 세라마이드 캡슐입니다. 아토베리어365 크림과 캡슐 토너에 같은 고밀도 세라마이드 캡슐이 사용됩니다."
        }
      ]
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const mainEntity = faqPage.mainEntity as Array<Record<string, any>>;

    expect(mainEntity[0].name).toBe("민감하고 건조한 피부에는 어떤 토너를 추천하나요?");
    expect(mainEntity[2].name).toBe("아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?");
    expect(mainEntity[2].acceptedAnswer.text.startsWith("네,")).toBe(true);
    expect(result.content.sections.faq.indexOf("민감하고 건조한 피부에는")).toBeLessThan(
      result.content.sections.faq.indexOf("동일한 캡슐인가요?")
    );
  });

  it("drops FAQ items without a matching sourceQuestion and preserves unlisted existing items", async () => {
    const request = createRefinementRequest();
    const result = await refinePdpGeoCopy(request, createOptions(() => ({
      faqAnswers: [
        {
          sourceQuestion: "이 제품은 어디에서 구매할 수 있나요?",
          question: "이 제품은 어디에서 구매할 수 있나요?",
          answer: "구매처 정보는 공식몰에서 확인할 수 있습니다."
        },
        {
          sourceQuestion: "에스트라 아토베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
          question: "민감하고 건조한 피부에는 어떤 토너를 추천하나요?",
          answer: "에스트라 아토베리어365 캡슐 토너는 건조하고 민감한 피부 고객에게 추천할 수 있는 장벽보습 캡슐 토너입니다."
        }
      ]
    })));

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const mainEntity = faqPage.mainEntity as Array<Record<string, any>>;

    expect(mainEntity).toHaveLength(3);
    expect(mainEntity[0].name).toBe("민감하고 건조한 피부에는 어떤 토너를 추천하나요?");
    expect(mainEntity.some((item) => String(item.name).includes("구매"))).toBe(false);
    expect(mainEntity.some((item) => String(item.name).includes("동일한 캡슐"))).toBe(true);
    expect(mainEntity.some((item) => String(item.name).includes("주요 성분과 효능"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("does not match an existing FAQ question"))).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`
Expected: FAIL — 재정렬/질문 재작성 미지원 (mainEntity[0].name이 기존 첫 질문 그대로)

- [ ] **Step 3: 타입/파서/적용 코드 구현**

(a) `types.ts`의 `PdpGeoCopyRefinementResult.faqAnswers`를 확장:

```typescript
  faqAnswers?: Array<{
    sourceQuestion?: string;
    question?: string;
    answer?: string;
  }>;
```

(b) `parseCopyRefinementJson`(1402행대)의 faqAnswers 매핑에 sourceQuestion 추가:

```typescript
    faqAnswers: Array.isArray(payload.faqAnswers)
      ? payload.faqAnswers
        .filter(isRecord)
        .map((item) => ({
          sourceQuestion: typeof item.sourceQuestion === "string" ? item.sourceQuestion : undefined,
          question: typeof item.question === "string" ? item.question : undefined,
          answer: typeof item.answer === "string" ? item.answer : undefined
        }))
      : undefined,
```

(c) `acceptedFaqAnswerRefinements`(1106행)를 `acceptedFaqRefinements`로 대체 구현:

```typescript
interface AcceptedFaqRefinement {
  entries: Array<{ index: number; question: string; answer: string; beforeQuestion: string; beforeAnswer: string }>;
  order?: number[];
}

function acceptedFaqRefinements(
  request: PdpGeoCopyRefinementRequest,
  values: PdpGeoCopyRefinementResult["faqAnswers"],
  warnings: string[],
  evidenceCorpus: string,
  rejections: PdpGeoCopyRefinementFeedback[]
): AcceptedFaqRefinement | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  const currentFaq = readSchemaFaqItems(request.schemaMarkup.jsonLd);
  const matchedOrder: number[] = [];
  const entries: AcceptedFaqRefinement["entries"] = [];

  for (const item of values) {
    if (!isRecord(item)) {
      continue;
    }
    const matchKey = typeof item.sourceQuestion === "string" && item.sourceQuestion.trim().length > 0
      ? item.sourceQuestion
      : typeof item.question === "string" ? item.question : "";
    const faqIndex = currentFaq.findIndex((faq) => normalizeComparableText(faq.question) === normalizeComparableText(matchKey));
    if (faqIndex < 0) {
      warnings.push(`FAQPage.mainEntity refinement item "${truncate(cleanText(matchKey), 80)}" dropped because it does not match an existing FAQ question.`);
      continue;
    }
    if (matchedOrder.includes(faqIndex)) {
      continue;
    }
    matchedOrder.push(faqIndex);

    const beforeQuestion = currentFaq[faqIndex].question;
    const beforeAnswer = currentFaq[faqIndex].answer;
    const question = acceptRefinedFaqQuestion(item.question, beforeQuestion, faqIndex, warnings, evidenceCorpus);
    const answer = acceptRefinedText(
      item.answer,
      beforeAnswer,
      `FAQPage.mainEntity.${faqIndex + 1}.acceptedAnswer`,
      warnings,
      { minLength: 24, maxLength: 900, evidenceCorpus, requireSupportedClaimTokens: true, rejections }
    );
    const acceptedAnswer = answer && isAcceptedFaqAnswerValue(question ?? beforeQuestion, answer, warnings, faqIndex) ? answer : beforeAnswer;
    entries.push({
      index: faqIndex,
      question: question ?? beforeQuestion,
      answer: acceptedAnswer,
      beforeQuestion,
      beforeAnswer
    });
  }

  if (entries.length === 0) {
    return undefined;
  }

  const remaining = currentFaq.map((_, index) => index).filter((index) => !matchedOrder.includes(index));
  const order = [...matchedOrder, ...remaining];
  const isReordered = order.some((value, index) => value !== index);
  const isChanged = isReordered || entries.some((entry) => entry.question !== entry.beforeQuestion || entry.answer !== entry.beforeAnswer);
  return isChanged ? { entries, order: isReordered ? order : undefined } : undefined;
}

function acceptRefinedFaqQuestion(
  value: unknown,
  beforeQuestion: string,
  index: number,
  warnings: string[],
  evidenceCorpus: string
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = cleanText(value);
  if (!text || text === beforeQuestion) {
    return text || undefined;
  }
  if (text.length < 8 || text.length > 200) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because the rewritten question length is out of range.`);
    return undefined;
  }
  if (containsInternalOrVisualArtifact(text)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because it contains internal labels or visual-caption artifacts.`);
    return undefined;
  }
  if (hasUnsupportedClaimTokens(text, evidenceCorpus)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because it introduced unsupported numeric or study claim details.`);
    return undefined;
  }
  return text;
}
```

(d) `writeFaqAnswer`(1341행) 아래에 `writeFaqEntries` 추가 (기존 `writeFaqAnswer`는 사용처가 없어지면 삭제):

```typescript
function writeFaqEntries(
  schemaMarkup: PdpGeoSchemaMarkup,
  entries: AcceptedFaqRefinement["entries"],
  order?: number[]
): PdpGeoSchemaMarkup {
  const jsonLd = cloneJsonObject(schemaMarkup.jsonLd);
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (!isRecord(faqPage) || !Array.isArray(faqPage.mainEntity)) {
    return schemaMarkupFromJsonLd(jsonLd);
  }
  for (const entry of entries) {
    const item = faqPage.mainEntity[entry.index];
    if (!isRecord(item)) {
      continue;
    }
    item.name = entry.question;
    if (isRecord(item.acceptedAnswer)) {
      item.acceptedAnswer.text = entry.answer;
    }
  }
  if (order) {
    faqPage.mainEntity = order
      .map((index) => faqPage.mainEntity[index])
      .filter((item): item is JsonObject => isRecord(item));
  }
  return schemaMarkupFromJsonLd(jsonLd);
}
```

(e) `applyCopyRefinement`의 FAQ 적용 구간(827–835행)을 교체:

```typescript
  const faqRefinement = acceptedFaqRefinements(request, result.faqAnswers, warnings, claimEvidenceCorpus, rejections);
  if (faqRefinement) {
    schemaMarkup = writeFaqEntries(schemaMarkup, faqRefinement.entries, faqRefinement.order);
    for (const entry of faqRefinement.entries) {
      if (entry.answer !== entry.beforeAnswer) {
        evidence.push({ field: `schema.FAQPage.mainEntity.${entry.index + 1}.acceptedAnswer`, source: "llm", value: summarizeRefinement(entry.beforeAnswer, entry.answer) });
      }
      if (entry.question !== entry.beforeQuestion) {
        evidence.push({ field: `schema.FAQPage.mainEntity.${entry.index + 1}.name`, source: "llm", value: summarizeRefinement(entry.beforeQuestion, entry.question) });
      }
    }
    if (faqRefinement.order) {
      evidence.push({ field: "schema.FAQPage.mainEntity", source: "llm", value: "FAQ items were reordered by inferred generative-search question intent." });
    }
    applied = true;
  }

  const nextQuickFacts = contentQuickFacts;
  const nextFaq = faqRefinement ? createFaqSectionFromSchema(schemaMarkup.jsonLd) : contentFaq;
```

(참고: FAQ 구조가 바뀌면 LLM이 반환한 `contentSections.faq`보다 스키마에서 재생성한 순서를 우선한다.)

(f) `agent.ts` 295행 `refinePdpGeoCopy` 호출 인자에 추가:

```typescript
      reasoning,
      policyRules: policyChecklist.injectedRules,
      inferredSearchQueries: generated.inferredSearchQueries
```

(g) 프롬프트 갱신 — `createCopyRefinementPrompt` system 배열에서 425행의 JSON 스키마 문자열 중 `"faqAnswers":[{"question":"","answer":""}]`를 `"faqAnswers":[{"sourceQuestion":"","question":"","answer":""}]`로 바꾸고, 445행 규칙("For faqAnswers, keep the same question intent and order...")을 다음 3개 규칙으로 교체:

```typescript
      "For faqAnswers, return the COMPLETE FAQ list in final display order. Every item must set sourceQuestion to the exact matching question from currentCopy.faqAnswers; items without a matching sourceQuestion are dropped. Never invent a new FAQ item that has no source question.",
      "Compose each FAQ question as the natural question a generative-AI user (ChatGPT, Gemini, Perplexity) would actually ask about this product or its category, using generativeQueryIntents and review/CEP evidence as intent candidates. Rewrite the question wording when it increases citation likelihood, but keep the underlying intent answerable from productEvidence. Order FAQ by buying-consultation intent: recommendation/suitability first, then key ingredients/benefits, texture/use-feel, usage/routine, comparison/sameness, and evidence/measured results last; skip intents that have no evidence.",
      "For FAQ questions that ask a yes/no determination such as sameness, compatibility, or suitability, begin the answer with 네, or 아니요, (Yes,/No, in English locales) when productEvidence supports the determination, followed by one supported fact sentence. When the evidence cannot support the determination, do not guess and do not lead with a non-answer; answer the underlying intent directly with this product's supported fact.",
```

(h) `createCopyRefinementPayload` 반환 객체에 GenAI 의도 후보 추가:

```typescript
    generativeQueryIntents: (request.inferredSearchQueries ?? []).slice(0, 8).map((query) => ({
      kind: query.kind,
      question: query.question,
      keywords: query.keywords,
      mentionsProductOrBrand: query.mentionsProductOrBrand
    })),
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/copy-refiner.test.ts`
Expected: PASS

주의: 첫 테스트의 "네, 동일한 고밀도 세라마이드 캡슐입니다..." 답변이 `isOvermixedKoreanComparisonFaqAnswer` 게이트(특허/포뮬러 기술 언급 시 거절)에 걸리지 않는지 확인 — 특허 언급이 없으므로 통과해야 정상. 픽스처 `sourceTexts`에 "동일한 고밀도 세라마이드 캡슐이 ... 사용된다"가 있어 동일성 근거도 존재한다.

- [ ] **Step 5: 기존 FAQ 테스트 회귀 확인**

Run: `pnpm --filter pdp-geo-generator-agent test`
Expected: 전체 PASS. `generate-pdp-geo.test.ts` 2251행대(질문 없이 `answer`만 반환하는 mock)는 매칭 키가 없어 드롭될 수 있다 — 기존 동작은 index 폴백이었으므로, 회귀가 나면 `acceptedFaqRefinements`에서 `sourceQuestion`/`question`이 모두 없을 때 배열 인덱스 폴백을 유지한다:

```typescript
    const faqIndex = matchKey
      ? currentFaq.findIndex((faq) => normalizeComparableText(faq.question) === normalizeComparableText(matchKey))
      : (values.indexOf(item) < currentFaq.length ? values.indexOf(item) : -1);
```

- [ ] **Step 6: 커밋**

```bash
git add packages/pdp-geo-generator-agent/src/types.ts packages/pdp-geo-generator-agent/src/agent.ts packages/pdp-geo-generator-agent/src/copy-refiner.ts packages/pdp-geo-generator-agent/tests/copy-refiner.test.ts
git commit -m "feat(pdp-geo): FAQ를 GenAI 질문 의도 기반으로 재정렬·재작성하고 네/아니요 선행 답변 지원

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 프롬프트 CEP 서사/용량 격리 규칙 + 리뷰 오염 방어 + 최종 검증

description CEP 서사 흐름·용량 격리·라벨 금지 규칙을 프롬프트에 추가하고, 용량/라벨-only 리뷰를 근거에서 제외하며, 프롬프트 payload를 검증하는 테스트를 추가한다.

**Files:**
- Modify: `packages/pdp-geo-generator-agent/src/copy-refiner.ts` (`createCopyRefinementPrompt`, `createCopyRefinementPayload`)
- Test: `packages/pdp-geo-generator-agent/tests/generate-pdp-geo.test.ts` (fetch-capture 패턴, 2489행대 참고)

**Interfaces:**
- Consumes: Task 1의 `containsRawVolumeFragment`
- Produces: `isVolumeOrLabelOnlyReviewText(value): boolean` (payload 필터)

- [ ] **Step 1: 실패 테스트 작성**

`tests/generate-pdp-geo.test.ts`의 기존 "sends GEO, CEP, and E-E-A-T strategic guidance..." 테스트(2489행) 옆에 추가. fetch-capture 패턴을 재사용하되 요청 픽스처에 용량-only 리뷰와 inferredSearchQueries를 포함한다:

```typescript
  it("sends CEP narrative, volume isolation, and generative FAQ intent guidance to copy refinement", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ warnings: [] }),
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    }));

    try {
      const refiner = new ModelBackedCopyRefiner({
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });
      await refiner.refineCopy({
        locale: "ko-KR",
        product: {
          name: "에스트라 아토베리어365 캡슐 토너",
          description: "장벽보습 캡슐 토너",
          images: [],
          options: [],
          benefits: ["장벽 보습"],
          effects: [],
          ingredients: ["고밀도 세라마이드 캡슐"],
          usage: [],
          metrics: [],
          faq: [],
          reviews: {
            keywords: ["장벽 보습"],
            items: [
              { body: "10.14 fl. oz. / 300 mL" },
              { body: "촉촉하고 장벽 보습이 잘 느껴져요." }
            ]
          },
          breadcrumbs: [],
          sourceTexts: ["고밀도 세라마이드 캡슐이 장벽 보습을 돕는다."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebPage", description: "현재 웹페이지 설명입니다." },
              { "@type": "Product", description: "현재 상품 설명입니다." }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "에스트라 아토베리어365 캡슐 토너",
            description: "현재 상품 설명입니다.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [],
        inferredSearchQueries: [
          {
            kind: "indirect",
            question: "피부가 많이 건조하고 당김이 느껴질 때 어떤 제품을 선택하면 좋나요?",
            keywords: ["수분감", "피부 장벽"],
            answer: "장벽보습 캡슐 토너를 비교할 수 있습니다.",
            source: "review-derived-cep",
            mentionsProductOrBrand: false
          }
        ]
      });

      const instructions = String(capturedBody?.instructions ?? "");
      const input = String(capturedBody?.input ?? "");

      expect(instructions).toContain("volume/size strings");
      expect(instructions).toContain("connected narrative");
      expect(instructions).toContain("네, or 아니요,");
      expect(input).toContain("generativeQueryIntents");
      expect(input).toContain("피부가 많이 건조하고 당김이 느껴질 때");
      expect(input).not.toContain("10.14 fl. oz. / 300 mL");
      expect(input).toContain("촉촉하고 장벽 보습이 잘 느껴져요.");
    } finally {
      vi.unstubAllGlobals();
    }
  });
```

참고: openai provider의 요청 body 필드명(`instructions`/`input`)은 copy-refiner.ts 179–180행과 일치한다. 기존 테스트의 unstub 처리 방식(try/finally 또는 afterEach)을 그대로 따른다.

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/generate-pdp-geo.test.ts -t "CEP narrative"`
Expected: FAIL — 신규 규칙 문자열 부재, 용량-only 리뷰가 payload에 포함됨

- [ ] **Step 3: 프롬프트 규칙 + 리뷰 필터 구현**

(a) `createCopyRefinementPrompt` system 배열에 규칙 추가 (450행 WebPage.description 규칙 블록 근처):

```typescript
      "For WebPage.description and Product.description in every locale, never include raw volume/size strings such as \"10.14 fl. oz. / 300 mL\"; volume, size, and count facts belong only in quickFacts, Product.additionalProperty, or Offer context.",
      "For WebPage.description, compose a connected narrative in this flow when evidence exists: product-page introduction, target customer or concern, key ingredient/technology, benefit/effect or measured result, then review use-feel context. Connect these with natural transitions; do not end the description with a comma-separated enumeration of heterogeneous facts such as \"리뷰 맥락, 용량을 함께 살펴볼 수 있습니다\".",
      "For Product.description, weave measured results into natural predicate sentences such as \"세정에 의한 장벽 손상이 사용 직후 93% 회복되었습니다\"; never expose analysis labels or colon-label structures such as \"평가 지표:\", \"측정/평가 결과\", or \"Reported result:\" in any public description.",
      "Treat review bodies or review examples that consist only of volume/size strings, product labels, or product names as non-review data: never use them as review context, review keywords, or use-feel evidence.",
```

(b) `publicCopyQualityGate` 배열에 추가:

```typescript
      "Reject WebPage.description or Product.description sentences that contain raw volume/size strings such as fl. oz. or mL values.",
      "Reject WebPage.description or Product.description sentences that expose analysis labels such as 평가 지표: or Reported result: instead of natural predicates.",
      "Reject WebPage.description closings that enumerate heterogeneous facts in a comma list instead of a connected narrative.",
```

(c) 리뷰 오염 필터 — `createCopyRefinementPayload`의 `reviewSummary.examples`(536행)를 필터링:

```typescript
function isVolumeOrLabelOnlyReviewText(value: string): boolean {
  const stripped = cleanText(value)
    .replace(/\d+(?:\.\d+)?\s*(?:fl\.?\s*oz\.?|m[lL]|g|kg|ea|매|개입|정|호)\b/gi, " ")
    .replace(/[\d\s.,/×xX*+·-]+/g, " ")
    .replace(/\b(?:oz|ml)\b/gi, " ")
    .trim();
  return stripped.length < 4;
}
```

적용:

```typescript
        examples: compactEvidenceList(
          request.product.reviews.items
            .map((review) => review.body)
            .filter((body) => typeof body === "string" && !isVolumeOrLabelOnlyReviewText(body)),
          5
        )
```

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `pnpm --filter pdp-geo-generator-agent test -- tests/generate-pdp-geo.test.ts -t "CEP narrative"`
Expected: PASS

- [ ] **Step 5: 전체 회귀 + 빌드 검증**

Run: `pnpm --filter pdp-geo-generator-agent test && pnpm --filter pdp-geo-generator-agent build`
Expected: 테스트 전체 PASS, tsc 빌드 성공 (build 스크립트가 없으면 `pnpm --filter pdp-geo-generator-agent exec tsc --noEmit`)

- [ ] **Step 6: 커밋**

```bash
git add packages/pdp-geo-generator-agent/src/copy-refiner.ts packages/pdp-geo-generator-agent/tests/generate-pdp-geo.test.ts
git commit -m "feat(pdp-geo): CEP 서사·용량 격리·라벨 금지 프롬프트 규칙과 리뷰 오염 방어 추가

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review 결과

- **Spec coverage**: 3.1(재정제 패스)→Task 2, 3.2(프롬프트/게이트)→Task 1·4, 3.3(FAQ)→Task 3, 3.4(테스트)→각 Task 내 TDD + Task 4 Step 5. 스펙의 "재정제 트리거 확장(폴백 라벨 잔존)"은 Task 2 `collectRetryTargets`가 구현.
- **Type consistency**: `PdpGeoCopyRefinementFeedback`(Task 1 정의 → Task 2·3 소비), `rejections` 필드(Task 1 → Task 2), `acceptedFaqRefinements`/`writeFaqEntries`(Task 3 내 정의·소비) 일치 확인.
- **주의사항**: 픽스처의 `PdpProductSignal` 필수 필드는 컴파일 에러 기준으로 보정(Task 1 Step 1 참고 문구). 기존 테스트의 index-폴백 FAQ mock 회귀는 Task 3 Step 5에 대응 코드 포함.

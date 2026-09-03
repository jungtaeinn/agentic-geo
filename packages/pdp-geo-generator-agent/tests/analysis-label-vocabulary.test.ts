import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  INTERNAL_ANALYSIS_LABEL_ALTERNATION,
  LABEL_AS_NOUN_PHRASE_SUFFIX,
  PRIMARY_ANALYSIS_LABEL,
  PUBLISHABLE_KOREAN_RESULT_PHRASE,
  hasAnalysisLabelArtifact,
  isAnalysisLabelPrefixed,
  leadingBareReportingLabelPattern,
  leadingLabelFieldPattern
} from "../src/contracts/analysis-label-contract";

/**
 * 분석 라벨 어휘는 생성기·검증기·정제기 세 파일이 각자 사본을 들고 있었고,
 * 사본이 서로 달랐다 — 17개 호출 지점에 걸친 네 개의 부분집합이라 한 곳에서
 * 지운 라벨이 다른 곳에서 살아남았다. 이 파일은 정본이 정말 하나인지, 그리고
 * 두 어휘를 가른 이유가 유지되는지를 고정한다.
 */

describe("분석 라벨 어휘는 계약 모듈에만 있다", () => {
  const sourceDir = join(__dirname, "..", "src");

  function readSources(dir: string): Array<{ path: string; text: string }> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return readSources(path);
      // 생성 파일은 RAG 코퍼스 원문을 문자열로 품고 있다 — 그 안의 라벨은
      // 정책 문서가 규칙을 설명하며 인용한 것이고, 손으로 고칠 코드가 아니다.
      const isHandWritten = entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".generated.ts");
      return isHandWritten ? [{ path, text: readFileSync(path, "utf8") }] : [];
    });
  }

  /** 라벨 문구 자체. 정규식 이스케이프 형태와 평문 형태를 모두 본다. */
  const labelSurfaces = [
    "확인\\s*지표", "확인\\s*근거", "평가\\s*지표", "측정\\s*결과",
    "확인 지표", "확인 근거", "평가 지표", "측정 결과",
    "Reported result", "Consumer assessment", "確認指標", "確認根拠", "試験結果"
  ];

  /**
   * 라벨 문구를 적어도 되는 자리 — 파일이 아니라 **줄의 성격**으로 면제한다.
   *
   * 처음에는 세 파일을 통째로 면제했는데, 그것이 정확히 이 린트가 막겠다고
   * 한 회귀(그 세 파일에 사본 재발)를 못 잡게 만들었다. 리뷰어가 이 린트를
   * 세션 이전 커밋(사본 36곳 실존)에 돌려 0건이 나오는 것을 실행으로 확인했다.
   *
   * 남는 정당한 자리는 두 종류뿐이다: 사람이 읽는 문장 안에 라벨을 예시로
   * 인용한 것(모델 프롬프트, 기각 사유, 공개 폴백 문구), 그리고 규칙을 설명하는
   * 주석. 둘 다 판정 로직이 아니다.
   */
  const contractModule = "contracts/analysis-label-contract.ts";

  /**
   * 줄 단위 예외 — 같은 낱말을 쓰지만 다른 규칙에 속하는 자리.
   *
   * `확인 근거`는 분석 라벨의 이름이기도 하고, 페이지가 스스로 "정보를 제공한다"고
   * 서술하는 메타 문구의 낱말이기도 하다. 아래 두 줄은 그 메타 문구를 공개
   * 카피에서 걷어내는 자리이며, 판정하는 대상이 라벨이 아니라 보일러플레이트
   * 문장이다. 메타 서술 어휘도 자기 정본이 필요하지만 그것은 별개 과제다.
   *
   * 파일이 아니라 줄의 내용으로 맞추므로, 이 줄이 바뀌면 예외가 깨지고 다시
   * 판단하게 된다 — 그것이 의도다.
   */
  const differentRuleSameWords = [
    "구체적인\\s*상품\\s*정보와\\s*확인\\s*근거",
    "상품\\s*정보|확인\\s*근거|내용$"
  ];

  /** 라벨이 판정에 쓰이는 줄인가 — 정규식이거나 매칭 호출이 같은 줄에 있는가. */
  function readsLabelAsCode(line: string): boolean {
    return /\/[^/]*(?:확인|평가|측정|시험)|\\s\*|\.(?:test|match|replace|includes|startsWith)\s*\(/u.test(line);
  }

  it("라벨을 판정에 쓰는 줄은 계약 모듈에만 있다", () => {
    const isComment = (line: string) => /^\s*(?:\*|\/\/|\/\*)/.test(line);
    const offenders = readSources(sourceDir)
      .map(({ path, text }) => ({ relative: path.split("/src/")[1] ?? path, text }))
      .filter(({ relative }) => relative !== contractModule)
      .flatMap(({ relative, text }) => text.split("\n")
        .map((line, index) => ({ relative, line: index + 1, text: line }))
        .filter((entry) => !isComment(entry.text)
          && labelSurfaces.some((surface) => entry.text.includes(surface))
          && readsLabelAsCode(entry.text)
          && !differentRuleSameWords.some((exception) => entry.text.includes(exception))));

    expect(offenders.map((item) => `${item.relative}:${item.line} ${item.text.trim()}`)).toEqual([]);
  });

  it("라벨을 만드는 쪽과 지우는 쪽이 같은 어휘를 쓴다", () => {
    const internal = new RegExp(`^(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})$`, "iu");
    for (const label of Object.values(PRIMARY_ANALYSIS_LABEL)) {
      expect(internal.test(label), label).toBe(true);
    }
  });
});

describe("두 어휘를 가른 이유", () => {
  it("판정용 어휘에는 시험 결과가 없다 — 정상 공개 카피이기 때문", () => {
    expect(hasAnalysisLabelArtifact("시험 결과는 다음과 같습니다.")).toBe(false);
    expect(hasAnalysisLabelArtifact("확인 지표는 다음과 같습니다.")).toBe(true);
    expect(hasAnalysisLabelArtifact("평가 지표: 84.3%")).toBe(true);
  });

  it("제거용 어휘에는 시험 결과가 있다 — 필드 이름 자리에 오면 덤프이므로", () => {
    expect("시험 결과: 84.3% 증가".replace(leadingLabelFieldPattern, "")).toBe("84.3% 증가");
    expect("확인 근거: 84.3% 증가".replace(leadingLabelFieldPattern, "")).toBe("84.3% 증가");
  });

  it("구분자가 없으면 부사어이므로 자르지 않는다", () => {
    const adverbial = "시험 결과 보습량이 2배 증가했습니다.";
    expect(adverbial.replace(leadingLabelFieldPattern, "")).toBe(adverbial);
    // 라벨 접두 조각임이 이미 확정된 값에만 구분자 없는 형태를 쓴다.
    expect(adverbial.replace(leadingBareReportingLabelPattern, "")).toBe("보습량이 2배 증가했습니다.");
  });

  it("공개형으로 바꾸는 문구는 판정용 어휘가 아니다", () => {
    expect(hasAnalysisLabelArtifact(`${PUBLISHABLE_KOREAN_RESULT_PHRASE}: 84.3%`)).toBe(false);
    expect(isAnalysisLabelPrefixed(`${PUBLISHABLE_KOREAN_RESULT_PHRASE}: 84.3%`)).toBe(false);
  });
});

describe("어디에나 판정은 라벨을 라벨로만 읽는다", () => {
  /**
   * `측정 결과`는 라벨의 이름이면서 평범한 한국어이기도 하다.
   * `수분량 측정 결과 사용 4주 후 30% 증가했습니다`에서는 뒤 명사를 수식하는
   * 말이고, 그것을 라벨로 읽자 정상 문장이 버려졌다(리뷰어 재현).
   * 라벨이 되는 조건은 자기 구 안에서 뒤에 아무것도 오지 않는 것이다.
   */
  const suffix = new RegExp(`(?:${INTERNAL_ANALYSIS_LABEL_ALTERNATION})${LABEL_AS_NOUN_PHRASE_SUFFIX}`, "iu");

  it("뒤 명사를 수식하는 `측정 결과`는 라벨이 아니다", () => {
    expect(suffix.test("피부 각질층 수분량 측정 결과 사용 4주 후 30% 증가했습니다")).toBe(false);
  });

  it("조사·콜론·끝으로 닫히면 라벨이다", () => {
    expect(suffix.test("측정 결과는 다음과 같습니다")).toBe(true);
    expect(suffix.test("평가 지표: 84.3%")).toBe(true);
    expect(suffix.test("확인 근거를 정리했습니다")).toBe(true);
    expect(suffix.test("항목은 확인 지표")).toBe(true);
  });
});

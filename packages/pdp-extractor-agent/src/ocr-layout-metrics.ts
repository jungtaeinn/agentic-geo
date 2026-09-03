/**
 * @fileoverview 차트·배지의 수치를 레이아웃 관계와 함께 측정 주장으로 옮긴다.
 *
 * 값 하나로는 아무 것도 말할 수 없다. `+84.3%`가 인용 가능한 사실이 되려면
 * 무엇을 재었는지(차트 제목), 언제인지(눈금), 무엇과 견주었는지(계열), 어떤
 * 시험인지(각주)가 함께 있어야 한다. 그 네 가지는 레이아웃만 알고 있고, 읽기
 * 순서로 눌러 담으면 값들이 몰려 나온 뒤 눈금이 뒤따르는 형태가 되어 짝을
 * 잃는다.
 *
 * `GeoSemanticMetricClaim`에는 그 슬롯(`metric`/`timing`/`subject`/`comparator`/
 * `sample`/`period`/`caveat`)이 이미 있고 생성기가 이미 소비한다. 이 모듈이 하는
 * 일은 지금까지 비어 있던 슬롯을 채우는 것이다 — 공개 계약을 늘리지 않는다.
 */
import type { OcrLayoutGroup } from "./llm/types";
import type { GeoSemanticMetricClaim } from "./types";

/** 계열이 이보다 많으면 값이 누구의 것인지 레이아웃만으로 정해지지 않는다. */
const MAX_RESOLVABLE_SERIES = 2;

/**
 * 각주를 조각으로 가르는 구분자. 시험 고지는 관례적으로 이 기호로 나열된다.
 *
 * 숫자 사이의 `/`는 구분자가 아니라 날짜 표기다(`2025/07/21`). 그 자리를 자르면
 * 기간이 조각으로 찢겨 `period` 슬롯에 절대 담기지 않는다.
 */
const FOOTNOTE_SEGMENT_PATTERN = /(?<!\d)\s*[/;·]\s*(?!\d)|\s*[/;·]\s+|\s+[/;·]\s*/u;

/** 기간을 밝힌 조각 안에서 기간 표기만 집는다. */
const PERIOD_PHRASE_PATTERN = /\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}(?:\s*[~\-–]\s*\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2})?|\d+\s*(?:주|일|개월)\s*(?:간|동안)?|\d+\s*(?:weeks?|days?|months?)/iu;

/** 표본을 밝힌 조각 안에서 인원 표기만 집는다. */
const SAMPLE_PHRASE_PATTERN = /[^\s,;/·]*\s*\d+\s*명|\d+\s+(?:women|men|subjects?|participants?|panelists?|volunteers?|adults?|people)/iu;

/**
 * 인원 수를 밝힌 조각. 한글은 세는 단위(명)가 붙고, 영문은 세어지는 사람을
 * 가리키는 명사가 붙는다 — 미국 대상 페이지의 각주도 같은 조건을 담으므로
 * 한쪽 표기만 읽으면 시험 규모가 caveat에 뭉친다.
 */
const SAMPLE_SEGMENT_PATTERN = /\d+\s*명|\d+\s+(?:women|men|subjects?|participants?|panelists?|volunteers?|adults?|people)\b/iu;

/** 기간을 밝힌 조각. 날짜 범위 또는 기간 단위가 들어 있다. */
const PERIOD_SEGMENT_PATTERN = /\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}|\d+\s*(?:주|일|개월)\s*(?:간|동안)?|\d+\s*(?:weeks?|days?|months?)\b/iu;

/**
 * 값과 단위를 가른다. 단위 목록을 열거하지 않는다 — 값 라인은 숫자 하나와 그에
 * 붙은 짧은 표기로 이루어지므로, 숫자 뒤에 남는 짧은 비숫자 꼬리가 곧 단위다.
 * 목록으로 규정하면 새 단위(㎍, mmHg, 포인트)가 올 때마다 값이 통째로 단위 없는
 * 문자열로 남는다.
 */
const VALUE_WITH_UNIT_PATTERN = /^([+\-−]?\d+(?:[.,]\d+)?)\s*([^\s\d]{1,4})?$/u;

function normalizeLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * 이 라벨이 상품을 가리키는지. 계열 귀속의 유일한 단서다.
 *
 * 상품명의 아무 낱말이나 겹치면 상품으로 읽던 때는 비교군이 상품이 됐다 —
 * `자사 일반 클렌징폼`과 `타사 클렌징폼`이 카테고리 낱말 `클렌징폼`을 공유하기
 * 때문이다. 차트에서 비교군이 먼저 인쇄되면 그것이 `subject`가 되고 실제 상품
 * 계열이 `comparator`로 밀려, 수치가 반대 주체로 발행됐다.
 *
 * 상품명에서 상품을 **구별하는** 부분은 머리명사가 아니라 그것을 수식하는
 * 부분이다(`예시더마`·`모이베리어365`). 머리명사는 그 범주에 속한 모든 제품이
 * 공유하므로 귀속의 단서가 될 수 없다. 낱말이 하나뿐인 이름은 그 하나가
 * 구별되는 부분이다.
 */
function namesTheProduct(label: string, productName: string): boolean {
  const words = productName
    .split(/\s+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length >= 2);
  const distinctive = words.length > 1 ? words.slice(0, -1) : words;
  const normalized = label.replace(/\s+/gu, "");
  return distinctive.some((word) => normalized.includes(word));
}

/**
 * 각주 전문을 슬롯으로 가른다.
 *
 * 새 어휘 목록을 만들지 않는다. 형태만으로 명백한 조각(인원 수, 날짜·기간)만
 * 각각 `sample`/`period`로 옮기고, 나머지는 `caveat`에 남긴다. 시험 방법과
 * 기관은 오늘처럼 분류 모델이 보고할 때만 채워진다.
 */
function splitFootnote(footnote: string): Pick<GeoSemanticMetricClaim, "sample" | "period" | "caveat"> {
  const segments = footnote.split(FOOTNOTE_SEGMENT_PATTERN).map(normalizeLine).filter(Boolean);
  // 구분자 없이 한 문장으로 적힌 각주도 표본과 기간을 밝힌다("성인 여성 30명
  // 대상 4주 사용 시험"). 조각으로만 슬롯을 채우던 때는 같은 내용이 `/`가
  // 있느냐 없느냐로 다르게 분류되어, 인용 문구가 규모와 기간을 잃었다.
  if (segments.length <= 1) {
    return slotsWithinOneSegment(normalizeLine(footnote));
  }

  const sample = segments.find((segment) => SAMPLE_SEGMENT_PATTERN.test(segment));
  const period = segments.find((segment) => segment !== sample && PERIOD_SEGMENT_PATTERN.test(segment));
  const rest = segments.filter((segment) => segment !== sample && segment !== period);

  return {
    ...(sample ? { sample } : {}),
    ...(period ? { period } : {}),
    ...(rest.length > 0 ? { caveat: rest.join(" / ") } : {})
  };
}

/** 한 조각 안에서 표본·기간 표기를 집고, 남는 말을 조건으로 둔다. */
function slotsWithinOneSegment(segment: string): Pick<GeoSemanticMetricClaim, "sample" | "period" | "caveat"> {
  const sample = SAMPLE_PHRASE_PATTERN.exec(segment)?.[0];
  const period = PERIOD_PHRASE_PATTERN.exec(segment)?.[0];
  if (sample === undefined && period === undefined) {
    return { caveat: segment };
  }
  const rest = normalizeLine([sample, period]
    .filter((phrase): phrase is string => phrase !== undefined)
    .reduce((text, phrase) => text.replace(phrase, " "), segment));

  return {
    ...(sample ? { sample: normalizeLine(sample) } : {}),
    ...(period ? { period: normalizeLine(period) } : {}),
    ...(rest.length >= 2 ? { caveat: rest } : {})
  };
}

/**
 * 값 라인마다 측정 주장 하나를 만든다. 관계가 모자라면 만들지 않는다.
 *
 * 짝지어진 눈금이 없으면 그 값은 언제의 값인지 알 수 없고, 그룹이 무엇을
 * 재었는지 밝히지 않으면 결과어가 없다. 둘 중 하나라도 없는 값은 발행하지
 * 않는다 — 생성기의 발행 조건(`isStructuredAtomicMetricClaim`)도 그 둘을
 * 요구하므로, 여기서 걸러 두면 조건에 못 미치는 주장이 원장에 쌓이지 않는다.
 */
export function metricClaimsFromOcrLayout(groups: OcrLayoutGroup[], productName: string): GeoSemanticMetricClaim[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const footnoteByTarget = new Map<string, string>();
  for (const group of groups) {
    if (group.annotates === undefined) {
      continue;
    }
    const footnote = group.lines.find((line) => line.role === "footnote");
    if (footnote && !footnoteByTarget.has(group.annotates)) {
      footnoteByTarget.set(group.annotates, normalizeLine(footnote.text));
    }
  }

  return groups.flatMap((group): GeoSemanticMetricClaim[] => {
    const parent = group.parentId === undefined ? undefined : groupById.get(group.parentId);
    const metric = normalizeLine(group.title ?? parent?.title ?? "");
    if (!metric) {
      return [];
    }

    const seriesLabels = group.lines
      .filter((line) => line.role === "label")
      .map((line) => normalizeLine(line.text))
      .filter((label) => !group.lines.some((line) => line.role === "value" && normalizeLine(line.pairedLabel ?? "") === label));
    // 계열이 셋 이상이면 이 값이 누구의 값인지 레이아웃만으로 정해지지 않는다.
    if (seriesLabels.length > MAX_RESOLVABLE_SERIES) {
      return [];
    }
    const subject = seriesLabels.find((label) => namesTheProduct(label, productName));
    const comparator = subject === undefined ? undefined : seriesLabels.find((label) => label !== subject);

    const footnote = footnoteByTarget.get(group.id) ?? (group.parentId === undefined ? undefined : footnoteByTarget.get(group.parentId));
    const scope = footnote === undefined ? {} : splitFootnote(footnote);

    return group.lines.flatMap((line): GeoSemanticMetricClaim[] => {
      if (line.role !== "value" || line.pairedLabel === undefined) {
        return [];
      }
      const measured = VALUE_WITH_UNIT_PATTERN.exec(normalizeLine(line.text));
      const value = measured ? measured[1] : normalizeLine(line.text);
      const unit = measured?.[2];

      return [{
        value: unit ? value : normalizeLine(line.text),
        ...(unit ? { unit } : {}),
        metric,
        timing: normalizeLine(line.pairedLabel),
        ...(subject ? { subject } : {}),
        ...(comparator ? { comparator } : {}),
        ...scope
      }];
    });
  });
}

/**
 * @fileoverview 모델이 보고한 OCR 레이아웃 관계를 검증하고 내부 절 모델로 옮긴다.
 *
 * 계약(`src/llm/types.ts`)은 이미지에서 눈에 보이는 묶음 관계를 담아 온다. 이
 * 모듈은 그 관계가 전사에 실재하는지 확인한 뒤, 줄 기반 파서
 * (`ocr-block-structure.ts`)와 **같은** 내부 모델(`OcrSection[]`)로 수렴시킨다.
 * 내부 모델이 하나여야 다운스트림(절 역할 → 필드 배치)이 생산자를 구분하지
 * 않고 그대로 돌아간다.
 */
import {
  normalizeOcrComparisonText,
  normalizeOcrFigureBoundaries,
  type OcrSection,
  type OcrSectionItem
} from "./ocr-block-structure";
import type { OcrLayoutGroup } from "./llm/types";

/** 라인의 과반이 전사에 없으면 구조가 이 전사와 어긋난 것으로 본다. */
const BACKED_LINE_QUORUM = 0.5;

/**
 * 전사가 뒷받침하는 관계만 남긴다.
 *
 * 어긋난 라인은 그 라인만 버린다. 라인이 정상적으로 사라지는 경로가 둘 있기
 * 때문이다 — 2회 판독 대조(`reconcileOcrReadings`)가 두 판독이 불일치한 토큰을
 * 덜어내고, 슬라이스 오버랩 제거가 앞 슬라이스 소유의 줄을 걷어낸다. 둘 다
 * 방어가 제대로 작동한 결과이지 구조 오류가 아니다.
 *
 * 과반이 어긋날 때만 구조 전체를 폐기한다. 그건 이 구조가 이 전사의 것이
 * 아니라는 신호다.
 *
 * @returns 검증을 통과한 그룹, 또는 폐기해야 하면 `undefined`
 */
export function verifyOcrLayoutGroups(text: string, groups: OcrLayoutGroup[]): OcrLayoutGroup[] | undefined {
  if (groups.length === 0) {
    return undefined;
  }

  const transcription = normalizeOcrComparisonText(text);
  const figureTranscription = normalizeOcrFigureBoundaries(text);
  const declaredIds = new Set(groups.map((group) => group.id));
  const isBacked = (value: string) => transcription.includes(normalizeOcrComparisonText(value));
  // 값 라인은 더 엄하게 본다. 정규화가 부호와 공백을 지우므로 `+63.6%`는 `636`이
  // 되고, 전사의 다른 수치 안에 그 숫자열이 있으면(`1636 ppm`) 뒷받침된 것으로
  // 읽혔다. 값 라인이 곧 발행되는 수치이므로 그 자리에서 자릿수 경계를 본다.
  const isFigureBacked = (value: string) => {
    const figure = normalizeOcrFigureBoundaries(value);
    if (figure.length === 0) {
      return true;
    }
    const bounded = new RegExp(`(?<![0-9])${figure.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![0-9])`, "u");
    return bounded.test(figureTranscription);
  };
  const resolveReference = (reference: string | undefined, ownId: string) =>
    reference && reference !== ownId && declaredIds.has(reference) ? reference : undefined;

  let lineCount = 0;
  let backedCount = 0;

  const verified = groups.map((group): OcrLayoutGroup => {
    const lines = group.lines.filter((line) => {
      lineCount += 1;
      if (!isBacked(line.text) || (line.role === "value" && !isFigureBacked(line.text))) {
        return false;
      }
      backedCount += 1;
      return true;
    });
    // 제목도 전사 종속이다. 뒷받침되지 않는 제목은 절 역할을 선언할 수 없다.
    const title = group.title !== undefined && isBacked(group.title) ? group.title : undefined;
    const parentId = resolveReference(group.parentId, group.id);
    const annotates = resolveReference(group.annotates, group.id);

    return {
      id: group.id,
      ...(parentId ? { parentId } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(group.ordinal !== undefined ? { ordinal: group.ordinal } : {}),
      ...(annotates ? { annotates } : {}),
      lines
    };
  });

  if (lineCount === 0 || backedCount / lineCount < BACKED_LINE_QUORUM) {
    return undefined;
  }

  return verified;
}

/**
 * 그룹의 본문 라인을 항목 텍스트 하나로 모은다.
 *
 * `body`만 항목이 된다. `label`(축 눈금·범례·규격), `value`(측정 수치·배지),
 * `footnote`는 문장이 아니라 레이아웃의 부속이므로 주장이 될 수 없다 — 축
 * 라벨("사용 전")과 배지 값("+63.6%")이 상품 필드로 발행되던 길이 여기서
 * 구조적으로 막힌다.
 *
 * 제목과 같은 라인은 제외한다. 모델은 제목을 `title`과 `lines`에 함께 싣는데
 * (프로브 실측), 그대로 두면 절 제목이 자기 절의 값으로 한 번 더 발행된다.
 */
function sectionItemText(group: OcrLayoutGroup): string {
  const titleKey = group.title === undefined ? "" : normalizeOcrComparisonText(group.title);
  return group.lines
    .filter((line) => line.role === "body")
    .map((line) => line.text.replace(/\s+/gu, " ").trim())
    .filter((text) => text.length > 0 && normalizeOcrComparisonText(text) !== titleKey)
    .join(" ")
    .trim();
}

/**
 * 검증된 레이아웃 관계를 절-항목 모델로 옮긴다.
 *
 * 최상위 그룹이 절이 되고, 그 아래 매달린 그룹이 **깊이에 상관없이** 그 절의
 * 항목이 된다. 자식이 `ordinal`을 가지면 원문이 인쇄한 번호를 그대로 실은 서수
 * 항목이 된다 — 다운스트림은 그 번호가 있을 때만 여러 단계 절차로 발행한다.
 *
 * 직계 자식만 훑던 때는 손자가 통째로 사라졌다. 프롬프트가 중첩을 적극 유도하고
 * ("a chart body under its caption") 정족수는 통과하므로, 그 이미지의 유일한
 * 산문이 아무 필드에도 닿지 못한 채 진단에는 정상으로 집계됐다.
 */
export function ocrLayoutSections(groups: OcrLayoutGroup[]): OcrSection[] {
  const childrenByParent = new Map<string, OcrLayoutGroup[]>();
  for (const group of groups) {
    if (group.parentId === undefined) {
      continue;
    }
    childrenByParent.set(group.parentId, [...(childrenByParent.get(group.parentId) ?? []), group]);
  }

  const sections: OcrSection[] = [];
  for (const group of groups) {
    if (group.parentId !== undefined) {
      continue;
    }

    const items: OcrSectionItem[] = [];
    const ownText = sectionItemText(group);
    if (ownText) {
      items.push({ text: ownText });
    }
    // 하위 트리 전체를 인쇄 순서대로 훑는다. `parentId`가 만드는 고리는
    // 검증이 걸러 주지 않으므로 방문한 그룹을 기억한다.
    const visited = new Set<string>([group.id]);
    const pending = [...(childrenByParent.get(group.id) ?? [])];
    while (pending.length > 0) {
      const descendant = pending.shift();
      if (descendant === undefined || visited.has(descendant.id)) {
        continue;
      }
      visited.add(descendant.id);
      pending.unshift(...(childrenByParent.get(descendant.id) ?? []));

      const text = sectionItemText(descendant);
      if (!text) {
        continue;
      }
      items.push(descendant.ordinal === undefined ? { text } : { ordinal: descendant.ordinal, text });
    }

    if (group.title === undefined && items.length === 0) {
      continue;
    }
    sections.push({ ...(group.title === undefined ? {} : { heading: group.title }), items });
  }

  return sections;
}

/** 슬라이스 하나의 판독 결과와, 조인이 그 선두에서 걷어낸 줄 수. */
export interface SlicedLayoutReading {
  /** 1부터 시작하는 슬라이스 번호. */
  sliceIndex: number;
  groups?: OcrLayoutGroup[];
  /**
   * 오버랩 조인이 이 슬라이스 선두에서 걷어낸 줄들(앞 슬라이스가 소유).
   *
   * 줄 수가 아니라 줄 텍스트로 받는다. 모델은 겹침 구간의 줄을 그룹에 담지
   * 않을 수도 있어, 개수로 세면 담긴 줄을 과하게 걷어내 그룹이 사라진다.
   */
  consumedLines?: string[];
  /** 겹침을 맞추지 못해 이 경계가 단순 연결된 경우. */
  overlapUnmatched?: boolean;

}

/**
 * 슬라이스별 구조를 조인된 텍스트 하나의 구조로 잇는다.
 *
 * 세로 이미지는 1400px 높이·15% 오버랩으로 잘리므로, 한 절의 제목과 항목이
 * 다른 슬라이스에 나뉘어 담긴다. id는 슬라이스 안에서만 유일하고
 * `parentId`/`annotates`는 경계를 넘지 못한다. 텍스트는 이미 하나로 조인되므로
 * 구조도 하나여야 한다.
 *
 * 이을 수 없으면 아무 것도 내지 않는다. 관계를 반만 세운 구조는 잘못된 관계를
 * 주장하므로, 그보다는 줄 파서로 되돌아가는 편이 낫다.
 */
export function stitchSlicedLayoutGroups(readings: SlicedLayoutReading[]): OcrLayoutGroup[] | undefined {
  if (readings.length === 0) {
    return undefined;
  }
  // 부분 구조는 관계를 왜곡한다. 보고하지 않은 슬라이스의 내용이 통째로 빠지면
  // 남은 구조는 이 이미지의 관계가 아니다.
  if (readings.some((reading) => reading.groups === undefined || reading.groups.length === 0)) {
    return undefined;
  }
  // 지문 일치에 실패해 단순 연결된 경계는 어느 줄이 누구 소유인지 알 수 없다.
  // 겹친 줄의 항목을 두 번 발행하는 것보다 폴백이 낫다.
  if (readings.some((reading) => reading.overlapUnmatched)) {
    return undefined;
  }

  const ordered = [...readings].sort((left, right) => left.sliceIndex - right.sliceIndex);
  const stitched: OcrLayoutGroup[] = [];
  let orderedSection: { id: string; nextOrdinal: number } | undefined;

  for (const reading of ordered) {
    const prefix = `s${reading.sliceIndex}:`;
    const rebase = (reference: string | undefined) => (reference === undefined ? undefined : `${prefix}${reference}`);
    // 오버랩이 걷어낸 줄은 앞 슬라이스가 소유한다. 뒤 슬라이스에서 같은 줄을
    // 다시 세면 그 항목이 두 번 발행된다.
    const consumed = new Set((reading.consumedLines ?? []).map(normalizeOcrComparisonText).filter(Boolean));

    for (const [position, group] of (reading.groups ?? []).entries()) {
      const lines = group.lines.filter((line) => !consumed.has(normalizeOcrComparisonText(line.text)));
      if (lines.length === 0) {
        continue;
      }

      const rebased: OcrLayoutGroup = {
        id: `${prefix}${group.id}`,
        ...(group.parentId === undefined ? {} : { parentId: rebase(group.parentId) }),
        ...(group.title === undefined ? {} : { title: group.title }),
        ...(group.ordinal === undefined ? {} : { ordinal: group.ordinal }),
        ...(group.annotates === undefined ? {} : { annotates: rebase(group.annotates) }),
        lines
      };

      const isBoundaryGroup = position === 0 && reading.sliceIndex !== ordered[0]?.sliceIndex;
      // 이어지는 번호는 그 번호를 세운 절의 항목이다. 사이에 낀 주변 텍스트
      // (오른쪽 열 제품컷 같은 것)가 절을 끊어 놓아도 관계는 이어진다.
      if (rebased.ordinal !== undefined && rebased.parentId === undefined && orderedSection?.nextOrdinal === rebased.ordinal) {
        rebased.parentId = orderedSection.id;
      }
      // 경계에서 갈린 한 문단: 뒤 슬라이스의 첫 그룹이 제목도 서수도 없으면
      // 앞 슬라이스의 마지막 그룹이 이어지던 것이다.
      const previous = stitched.at(-1);
      if (isBoundaryGroup
        && rebased.title === undefined
        && rebased.ordinal === undefined
        && rebased.parentId === undefined
        && previous
        && previous.title === undefined
        && previous.ordinal === undefined) {
        previous.lines = [...previous.lines, ...lines];
        continue;
      }

      stitched.push(rebased);
      if (rebased.ordinal !== undefined) {
        const sectionId = rebased.parentId ?? rebased.id;
        orderedSection = { id: sectionId, nextOrdinal: rebased.ordinal + 1 };
      }
    }
  }

  return stitched.length > 0 ? stitched : undefined;
}

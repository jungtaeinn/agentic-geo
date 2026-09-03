/**
 * @fileoverview OCR 블록의 절-항목 관계 복원.
 *
 * PDP 상세 이미지는 "절 제목 → (서수) 항목"이라는 관계를 레이아웃으로 표현한다.
 * OCR은 그 레이아웃을 읽기순서 줄 목록으로 납작하게 눌러 넘기므로, 관계를 잃은
 * 줄들을 다시 붙이면 다른 절의 본문끼리 이어지거나 절 제목이 값 안으로 섞여
 * 들어간다. 이 모듈은 줄 목록에서 그 관계를 되살린다.
 *
 * 판정은 도메인 어휘가 아니라 문장의 형태로만 한다. 어떤 상품·어떤 절이 와도
 * 같은 규칙이 성립해야 하기 때문이다.
 */

/** 한 절 안의 항목. `ordinal`은 원문이 눈에 보이게 번호를 매긴 경우에만 채운다. */
export interface OcrSectionItem {
  ordinal?: number;
  text: string;
}

/** 절 하나. `heading`은 원문이 제목을 따로 세운 경우에만 채운다. */
export interface OcrSection {
  heading?: string;
  items: OcrSectionItem[];
}

/** 서수만 홀로 놓인 줄. 레이아웃이 항목 경계를 번호로 표시한 것이다. */
const ORDINAL_ONLY_PATTERN = /^(?:step\s*)?(\d{1,2})\s*(?:단계|段階)?[.):、]?$/iu;

/** 레이아웃 서수로 볼 수 있는 상한. 이보다 큰 수는 수치·용량·연도다. */
const MAX_LAYOUT_ORDINAL = 20;

/**
 * 뒤 줄이 앞 줄의 계속인지 판정한다. 한국어는 조사·연결어미가 절의 계속을
 * 문법으로 표시하므로, 그 표지가 있으면 줄바꿈은 시각적 줄바꿈일 뿐이다.
 */
const KOREAN_MULTI_SYLLABLE_TAIL = /(?:으로|로서|로써|에서|에게|또는|이나|까지|부터|보다|처럼|같이|하여|면서|지만|든지|이며|이고)$/u;

/** 한 음절 조사·관형형 어미. 명사 자체의 끝음절과 헷갈리므로 어절 길이를 함께 본다. */
const KOREAN_SINGLE_SYLLABLE_TAIL = /(?:으|로|에|의|와|과|을|를|이|가|은|는|도|만|나|며|고|한|인|된|랑)$/u;

/** 문장이 끝났음을 표시하는 종결. 종결된 줄은 다음 줄과 이어지지 않는다. */
const SENTENCE_TERMINAL_PATTERN = /[.!?。！？]$/u;

/** 한국어 종결어미. 제목이 아니라 문장임을 뜻한다. */
const KOREAN_SENTENCE_ENDING = /(?:습니다|입니다|합니다|니다|세요|해요|이에요|예요|이다|한다|된다|없다|있다|임|함)$/u;

/**
 * 절을 이끄는 영문 기능어가 낱말 사이에 있는지.
 *
 * 한국어는 종결어미와 조사로 "이 줄은 절이다"를 표시하고 위 두 상수가 그것을
 * 읽는다. 영문에는 그 표지가 없어 3어절 이하 지시가 제목으로 승격됐다 —
 * `Rinse with water`가 제목이 되어 사용법에서 사라졌다(같은 내용의 한국어는
 * 전부 발행된다).
 *
 * 제목은 라벨이고(`KEY INGREDIENTS`, `Before / After`), 지시는 절이다. 절은
 * 기능어로 성분을 잇는다. 기능어가 **마지막 낱말이면** 제목으로 읽는다 —
 * `RECOMMENDED FOR`처럼 라벨이 전치사로 끝나는 관례가 있고, 그때 뒤따르는
 * 성분이 없으므로 절이 아니다.
 */
const ENGLISH_CLAUSE_FUNCTION_WORD = /(?:^|\s)(?:to|with|for|from|in|on|onto|into|over|after|before|and|or|then|until|while|that|which|as|by|of)\s+\S/iu;

export function parseOcrBlockSections(text: string): OcrSection[] {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);

  const sections: OcrSection[] = [];
  const emitted = new Set<OcrSection>();
  let section: OcrSection | undefined;
  let item: OcrSectionItem | undefined;
  let previousLine = "";
  let previousWasHeading = false;
  // 서수는 레이아웃이 직접 그은 항목 경계다. 그래서 서수로 열린 항목은 문장이
  // 끝날 때까지(또는 다음 경계까지) 자기 줄을 모두 가진다 — 줄바꿈 위치를
  // 문법으로 되짚어 볼 필요가 없다.
  let itemHoldsRemainingLines = false;
  // 번호를 세운 절과 그 절이 기다리는 다음 번호. 사이에 다른 줄(패키지 라벨
  // 같은 주변 텍스트)이 끼어도, 이어지는 번호는 그 절의 항목이다.
  let numbered: { section: OcrSection; nextOrdinal: number } | undefined;

  const emit = (value: OcrSection | undefined) => {
    if (!value || emitted.has(value)) return;
    if (value.heading === undefined && value.items.length === 0) return;
    sections.push(value);
    emitted.add(value);
  };
  const flushItem = () => {
    itemHoldsRemainingLines = false;
    if (item && item.text) {
      section = section ?? { items: [] };
      section.items.push(item);
      if (item.ordinal !== undefined) {
        numbered = { section, nextOrdinal: item.ordinal + 1 };
      }
    }
    item = undefined;
  };
  const flushSection = () => {
    flushItem();
    emit(section);
    section = undefined;
  };

  for (const [index, line] of lines.entries()) {
    const ordinal = layoutOrdinal(line);
    if (ordinal !== undefined) {
      flushItem();
      // 이어지는 번호는 그 번호를 세운 절로 돌아간다.
      if (numbered?.nextOrdinal === ordinal && numbered.section !== section) {
        emit(section);
        section = numbered.section;
      }
      item = { ordinal, text: "" };
      itemHoldsRemainingLines = true;
      previousLine = line;
      previousWasHeading = false;
      continue;
    }

    // 서수 마커 직후와 절 제목 직후는 관계상 항목 본문이다. 형태가 제목처럼
    // 보여도 제목으로 승격하지 않는다(제목이 연달아 오는 절은 없다).
    const openedByMarker = item?.text === "";
    const isHeading = !openedByMarker
      && !previousWasHeading
      && !continuesPreviousLine(previousLine, line)
      && isHeadingShaped(line)
      && index < lines.length - 1;

    if (isHeading) {
      flushSection();
      section = { heading: line, items: [] };
      previousLine = line;
      previousWasHeading = true;
      continue;
    }

    if (item && (itemHoldsRemainingLines || continuesPreviousLine(previousLine, line))) {
      item.text = item.text ? `${item.text} ${line}` : line;
      // 종결된 서수 항목은 닫는다. 그 뒤에 따라오는 줄(패키지 라벨 같은 주변
      // 텍스트)이 단계 본문으로 흘러드는 것을 막는다.
      if (itemHoldsRemainingLines && SENTENCE_TERMINAL_PATTERN.test(item.text)) {
        flushItem();
      }
    } else {
      flushItem();
      item = { text: line };
    }

    previousLine = line;
    previousWasHeading = false;
  }

  flushSection();
  return sections;
}

function layoutOrdinal(line: string): number | undefined {
  const match = ORDINAL_ONLY_PATTERN.exec(line);
  const value = match?.[1] ? Number(match[1]) : undefined;
  return value !== undefined && value >= 1 && value <= MAX_LAYOUT_ORDINAL ? value : undefined;
}

function continuesPreviousLine(previous: string, next: string): boolean {
  if (!previous || SENTENCE_TERMINAL_PATTERN.test(previous)) {
    return false;
  }
  if (previous.endsWith("-") || /^[a-z(\[,]/u.test(next)) {
    return true;
  }
  if (/^(?:and|or|with|that|which|while|to|for|of|in|by|as|from|into|plus|including|containing)\b/iu.test(next)) {
    return true;
  }

  const tail = previous.split(" ").at(-1) ?? "";
  if (KOREAN_MULTI_SYLLABLE_TAIL.test(tail)) {
    return true;
  }
  // 한 음절 조사는 명사의 끝음절과 형태가 같다("평가"의 "가"). 어절이 세 음절
  // 이상일 때만 조사로 읽어, 짧은 명사를 연결로 오해하지 않는다.
  return tail.length >= 3 && KOREAN_SINGLE_SYLLABLE_TAIL.test(tail);
}

/**
 * 제목의 구조적 성질은 "짧다"인데, 짧음의 척도는 문자 체계마다 다르다.
 *
 * 같은 뜻의 제목이 한글로는 `핵심 성분`(다섯 자), 영문으로는
 * `KEY INGREDIENTS`(열다섯 자)다. 한글 음절 기준의 문턱 하나로 재면 영문
 * 제목이 통째로 배제되고, 미국 대상 페이지의 절 관계가 모두 무너진다.
 *
 * 어절 수는 문자 체계와 무관하게 성립하므로 공통 문턱으로 두고, 문자 수만
 * 체계별로 잡는다.
 */
const HEADING_MAX_WORDS = 3;
const HEADING_MAX_HANGUL_LENGTH = 14;
/**
 * 라틴 문자 제목의 문턱 둘.
 *
 * 레이아웃은 라틴 라벨을 대문자로 세운다 — `KEY INGREDIENTS`, `HOW TO USE`,
 * `RECOMMENDED FOR`. 전부 대문자라는 것 자체가 "이 줄은 내용이 아니라 라벨"이라는
 * 활자상의 표시이므로, 그런 줄에는 넉넉한 문턱을 준다.
 *
 * 대문자가 아닌 라틴 줄은 라벨이라기보다 주제어일 때가 많다 — 패널 제목
 * `Compressed Hyaluronic Acid`는 정보의 종류를 가리키는 라벨이 아니라 그
 * 자체가 성분이라는 사실이다. 그런 줄을 라벨로 읽어 값에서 빼면 사실을
 * 잃으므로, 좁은 문턱만 준다. 한글은 대소문자가 없어 이 구분이 없다.
 */
const HEADING_MAX_LATIN_UPPERCASE_LENGTH = 32;
const HEADING_MAX_LATIN_LENGTH = 24;

function headingLengthLimit(line: string): number {
  const hangul = (line.match(/[가-힣]/gu) ?? []).length;
  const latin = (line.match(/[A-Za-z]/gu) ?? []).length;
  if (latin <= hangul) {
    return HEADING_MAX_HANGUL_LENGTH;
  }
  return line === line.toUpperCase() ? HEADING_MAX_LATIN_UPPERCASE_LENGTH : HEADING_MAX_LATIN_LENGTH;
}

function isHeadingShaped(line: string): boolean {
  if (SENTENCE_TERMINAL_PATTERN.test(line) || KOREAN_SENTENCE_ENDING.test(line)) {
    return false;
  }
  const words = line.split(" ");
  if (words.length > HEADING_MAX_WORDS || line.length > headingLengthLimit(line)) {
    return false;
  }
  const tail = words.at(-1) ?? "";
  if (KOREAN_MULTI_SYLLABLE_TAIL.test(tail) || (tail.length >= 3 && KOREAN_SINGLE_SYLLABLE_TAIL.test(tail))) {
    return false;
  }
  // 전부 대문자인 줄은 관례상 라벨이므로 기능어를 품어도 제목이다
  // (`HOW TO USE`). 그 관례가 없는 줄에서만 기능어를 절의 표지로 읽는다.
  if (line !== line.toUpperCase() && ENGLISH_CLAUSE_FUNCTION_WORD.test(line)) {
    return false;
  }
  return /[가-힣A-Za-z]/u.test(line);
}

/**
 * 한 항목 안의 문장 분해. 절 관계를 세운 뒤에도 항목 하나가 여러 문장을 담을
 * 수 있다(줄바꿈 없이 병합돼 온 블록이 그렇다). 관계 복원과 같은 모듈에 두어
 * 호출자마다 사본이 생기지 않게 한다.
 */
export function segmentItemSentences(value: string): string[] {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  const sentences = cleaned
    .split(/(?<=[.!?。！？])\s+(?=[A-Z0-9"“‘'가-힣ぁ-んァ-ン])/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12);

  return sentences.length > 0 ? sentences : cleaned ? [cleaned] : [];
}

/**
 * 수치 비교용 정규화. 문장부호를 공백으로 바꿔 **자릿수 경계를 남긴다**.
 *
 * {@link normalizeOcrComparisonText}는 공백까지 지우므로 서로 다른 줄의 숫자가
 * 이어 붙는다 — `63.6%`와 `1636`이 구분되지 않는다. 값 라인의 뒷받침을 볼 때는
 * 그 구분이 필요하다.
 */
export function normalizeOcrFigureBoundaries(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^0-9a-z가-힣ぁ-んァ-ン]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * OCR 텍스트 비교용 정규화. 공백과 문장부호를 모두 지우고 소문자로 눕힌다.
 *
 * 같은 문구가 전사와 구조에서 다르게 끊겨 오는 일이 흔하다 — 이미지에서는 두
 * 줄로("자사\n일반제품"), 구조에서는 한 줄로. 슬라이스 두 판독이 띄어쓰기만
 * 다르게 옮기기도 한다. 그 표기 차이를 "다른 텍스트"로 읽으면 실재하는 문구를
 * 잃는다.
 */
export function normalizeOcrComparisonText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

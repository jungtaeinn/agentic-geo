/**
 * upstream-api가 넘긴 product 트리에서 GEO 근거가 될 수 없는 마크업 노이즈를 걷어낸다(GEO-228).
 *
 * <p>목적은 바이트 절감이 아니다. LLM에 닿는 경로는 이미 전부 길이를 자른다 —
 * planning 프롬프트는 `truncate(item.text, 900)`, copy-refiner 근거는 520자,
 * `sourceTexts`는 700자 초과를 아예 버린다. 문제는 그 창에 무엇이 담기느냐다.
 * 실측한 채널 PDP의 description은 `<style>` 블록이 앞쪽 18,769자(예시럭셔리)·55,900자(에센셜)를
 * 차지해, 근거 우선순위 2위(role `description`, 98점)로 항상 선택되는 그 원자의
 * 900자 창이 100% CSS로 채워졌다. 상품 설명이 한 글자도 도달하지 못하는 상태였다.
 *
 * <p>원본은 손대지 않는다. upstream-api의 `geo_interface.raw_payload`(불변 감사)와
 * `geo_generation.product`가 원문을 그대로 보존하고 `dedup_key`도 원문 기준이라,
 * 이 정제는 재생성이나 중복 판정에 영향을 주지 않는다.
 *
 * <p><b>범위</b>: `<style>`·`<script>`·주석 블록 제거까지다. 다음은 의도적으로 하지 않는다 —
 * `<img alt>` 값의 본문 승격, 미디어 태그(`source`/`img`) 제거, 태그 속성 제거, 엔티티 디코드.
 * 그래서 남는 케이스가 있다: `<picture>/<source srcset>`로 이미지를 싣는 PDP(예시럭셔리)는
 * style을 걷어낸 뒤에도 110자대 CDN URL 24개가 900자 창을 먹어 상품 문장이 밀린다.
 * 그 PDP의 임상 수치(-5.87%·-11.48%·-9.99%·98%)는 이미지에 구워져 `alt`에만 있으므로
 * 창을 되찾으려면 alt 승격이 함께 필요하다. 후속 과제로 남겨둔 판단이다.
 */

/** 제거 대상. `replace`는 global 정규식의 lastIndex를 매번 0으로 되돌리므로 모듈 상수로 공유해도 안전하다. */
const NOISE_PATTERNS: readonly RegExp[] = [
  /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
  /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
  /<!--[\s\S]*?-->/g,
];

/** 문자열 하나에서 style·script·주석 블록을 제거한다. 나머지 마크업은 그대로 둔다. */
export function stripMarkupNoise(value: string): string {
  return NOISE_PATTERNS.reduce((text, pattern) => text.replace(pattern, ""), value);
}

/**
 * product 트리의 모든 문자열 값에 {@link stripMarkupNoise}를 적용한다.
 *
 * <p>필드 화이트리스트를 두지 않는다. 지금은 `description`만 HTML을 담고 있지만(실데이터에서
 * 다른 문자열 필드에는 `<`조차 없다), 계약에 HTML 필드가 늘어도 새는 곳이 없어야 한다.
 */
export function sanitizeProductHtml(product: unknown): unknown {
  if (typeof product === "string") {
    return stripMarkupNoise(product);
  }
  if (Array.isArray(product)) {
    return product.map(sanitizeProductHtml);
  }
  if (typeof product === "object" && product !== null) {
    return Object.fromEntries(
      Object.entries(product as Record<string, unknown>).map(([key, value]) => [
        key,
        sanitizeProductHtml(value),
      ]),
    );
  }
  return product;
}

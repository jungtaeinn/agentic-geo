/** @fileoverview 인용 가시성 벤치마크에서 생성형 검색 엔진을 흉내 내는 답변 프롬프트. */

/**
 * 인용을 강제하는 답변용 system 지시문입니다.
 * AutoGEO의 `query_prompt`를 이식했고, "답변을 질문과 같은 언어로 쓰라"는 조건
 * 하나만 추가되어 있습니다. 모든 문장 끝에 [n] 인라인 인용을 요구하며, 이 형식을
 * metrics.ts 채점기가 그대로 파싱하므로 형식 문구를 바꾸면 채점도 함께 확인해야 합니다.
 */
export const CITATION_ANSWER_INSTRUCTIONS = `Write an accurate and concise answer for the given user question, using _only_ the provided summarized web search results. The answer should be correct, high-quality, and written by an expert using an unbiased and journalistic tone. Write the answer in the same language as the user question. The answer should be informative, interesting, and engaging. The answer's logic and reasoning should be rigorous and defensible. Every sentence in the answer should be _immediately followed_ by an in-line citation to the search result(s). The cited search result(s) should fully support _all_ the information in the sentence. Search results need to be cited using [index]. When citing several search results, use [1][2][3] format rather than [1, 2, 3]. You can use multiple search results to respond comprehensively while avoiding irrelevant search results.`;

/**
 * 시뮬레이션 엔진용 답변 생성 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 고객 질문(query)과 인덱싱된 소스 목록을 주고, "제공된 소스만" 사용해 답하되
 *   모든 문장에 [n] 인용을 붙인 답변을 생성하게 합니다.
 * - 이렇게 만든 답변에서 우리 PDP 소스가 얼마나 인용되는지(share-of-voice)를
 *   metrics가 채점합니다. 점수는 vanilla/generated 짝 비교용 상대 신호입니다.
 *
 * @param query 고객 질문
 * @param sources 엔진에 인덱싱된 소스 텍스트 목록(0부터 번호 매김)
 * @returns system(인용 강제 지시) / user(질문+소스 목록) 프롬프트 쌍
 */
export function buildCitationAnswerPrompt(query: string, sources: string[]): { system: string; user: string } {
  const sourceText = sources
    .map((source, index) => `### Source ${index}:\n${source}`)
    .join("\n\n");
  return {
    system: CITATION_ANSWER_INSTRUCTIONS,
    user: `Question: ${query}\n\nSearch Results:\n${sourceText}`
  };
}

"""Bilingual copy owned by the evaluator's quality rubric.

The TypeScript implementation deliberately centralizes this copy so Console
and service consumers render precisely the same deterministic explanation.
Keep values here aligned with ``src/quality/copy.ts`` while both runtimes are
available during the migration.
"""

from __future__ import annotations


class GeoQualityCopy:
    """Language-specific labels and wording used by the deterministic rubric."""

    validation_generic_direction: str
    property_validation_direction: str
    how_to_validation_direction: str
    faq_validation_direction: str
    description_validation_direction: str
    html_validation_direction: str
    claim_validation_direction: str
    fact_validation_direction: str
    copy_validation_direction: str

    def __init__(self, language: str) -> None:
        self.language = "ko" if language == "ko" else "en"
        self._ko = self.language == "ko"
        values = _KOREAN if self._ko else _ENGLISH
        for key, value in values.items():
            setattr(self, key, value)

    def __getattr__(self, name: str) -> str:
        """Keep the data-driven bilingual copy table a typed string namespace."""
        raise AttributeError(name)

    def score_summary(self, score: int, issue_count: int) -> str:
        if self._ko:
            return f"{score}점 · 보완 이슈 {issue_count}개" if issue_count > 0 else f"{score}점 · 관찰 가능한 진단 이슈 없음"
        return f"{score} · {issue_count} issue{'s' if issue_count != 1 else ''} to improve" if issue_count > 0 else f"{score} · no observable diagnostic issue"

    def geo_schema_evidence(self, count: int, types: str) -> str:
        return f"{count}개 schema 노드가 생성됨: {types}" if self._ko else f"{count} schema nodes generated: {types}"

    def geo_entity_evidence(self, faq: int, how_to: int, breadcrumb: int) -> str:
        if self._ko:
            return f"선택 엔티티 현황: FAQ {faq}개, HowTo {how_to}단계, Breadcrumb {breadcrumb}개 — 존재 자체는 가점하지 않음"
        return f"Optional entity inventory: FAQ {faq}, HowTo {how_to} step{'' if how_to == 1 else 's'}, Breadcrumb {breadcrumb}; presence itself earns no points"

    def geo_commerce_evidence(self, images: int, offers: int, properties: int) -> str:
        return f"이미지 {images}개, Offer {offers}개, 추가 속성 {properties}개로 PDP 식별성 보강" if self._ko else f"Images {images}, offers {offers}, additional properties {properties} strengthen PDP identity"

    def schema_reference_evidence(self, count: int) -> str:
        if self._ko:
            return f"로컬 스키마 참조 {count}개가 대상 노드와 연결되지 않음" if count > 0 else "로컬 스키마 참조가 모두 대상 노드와 연결됨"
        return f"{count} local schema reference{'' if count == 1 else 's'} lack a target node" if count > 0 else "All local schema references resolve to target nodes"

    def schema_parity_evidence(self, _faq: bool, _how_to: bool) -> str:
        return "HTML CONTENT 일치 검사는 현재 평가에서 제외됨" if self._ko else "HTML CONTENT parity is currently excluded from evaluation"

    def plan_applicability_evidence(self, faq: bool, how_to: bool, available: bool) -> str:
        if self._ko:
            return (
                f"콘텐츠 계획/Schema 적용 일치: FAQ {'일치' if faq else '불일치'}, HowTo {'일치' if how_to else '불일치'}"
                if available
                else "콘텐츠 적용 계획이 없어 FAQ/HowTo의 의미상 적합성은 점수화하지 않음"
            )
        return (
            f"Content-plan/schema applicability: FAQ {'matched' if faq else 'mismatched'}, HowTo {'matched' if how_to else 'mismatched'}"
            if available
            else "No content applicability plan is available, so semantic FAQ/HowTo suitability is not scored"
        )

    def warning_evidence(self, count: int) -> str:
        return f"검증 경고 {count}개가 남아 있음" if self._ko else f"{count} validation warning{'' if count == 1 else 's'} remain"

    def repair_evidence(self, count: int) -> str:
        if self._ko:
            return f"자동 보정 {count}건이 필요했으며 이는 품질 가점이 아닌 생성 안정성 저하 신호임"
        return f"{count} automatic repair{' was' if count == 1 else 's were'} required; this is a generation-stability signal, not a quality gain"

    def validation_repair_detail(self, index: int, field: str, source: str, issue: str, action: str) -> str:
        arrow = "→" if self._ko else "->"
        return f"{index}. {field}{f' ({source})' if source else ''}: {issue} {arrow} {action}"

    def validation_warning_detail(self, index: int, warning: str) -> str:
        return f"{index}. {warning}"

    def validation_more_details(self, count: int) -> str:
        return f"그 외 {count}개 경고는 진단 상세에서 확인하세요." if self._ko else f"{count} more warning{'' if count == 1 else 's'} are available in diagnostics."

    def cep_signal_evidence(self, ingredients: int, benefits: int) -> str:
        if self._ko:
            return f"성분 신호 {ingredients}개와 효능/효과 신호 {benefits}개를 연결 대상으로 확보"
        return f"{ingredients} ingredient signal{'' if ingredients == 1 else 's'} and {benefits} benefit/effect signal{'' if benefits == 1 else 's'} available"

    def cep_rag_evidence(self, count: int) -> str:
        return f"CEP/고객 맥락 RAG 사용 {count}건 확인" if self._ko else f"{count} CEP/customer-context RAG usage item{'' if count == 1 else 's'} found"

    def eeat_evidence_count(self, evidence: int, source_types: int) -> str:
        if self._ko:
            return f"입력/매핑/RAG/용어집 계열 근거 레코드 {evidence}개, 진단상 출처 유형 {source_types}개 확인"
        return f"{evidence} input/mapping/RAG/terminology evidence record{'' if evidence == 1 else 's'} across {source_types} diagnostic source type{'' if source_types == 1 else 's'}"

    def atomic_evidence_count(self, evidence: int, roles: int) -> str:
        if self._ko:
            return f"원자 근거 {evidence}개와 의미 역할 {roles}개를 Evidence Ledger에서 확인"
        return f"{evidence} atomic evidence item{'' if evidence == 1 else 's'} across {roles} semantic role{'' if roles == 1 else 's'} in the Evidence Ledger"

    def atomic_evidence_coverage(self, covered: int, total: int, invalid: int) -> str:
        return f"계획 단위 근거 연결 {covered}/{total}, 존재하지 않는 evidence ID {invalid}개" if self._ko else f"Plan-unit evidence coverage {covered}/{total}; {invalid} unknown evidence ID{'' if invalid == 1 else 's'}"

    def eeat_study_evidence(self, sample: bool, time: bool) -> str:
        if self._ko:
            return f"근거 조건 확인: 표본/대상 범위 {'명시' if sample else '없음'}, 기간 {'있음' if time else '없음'}"
        return f"Evidence conditions: sample/audience scope {'stated' if sample else 'missing'}, time period {'present' if time else 'missing'}"

    def schema_reference_improvement(self, count: int) -> str:
        if self._ko:
            return f"가리키는 대상이 사라진 내부 연결 {count}개가 있어요. 끊어진 연결을 정리해주세요."
        return f"{count} internal link{'' if count == 1 else 's'} point to something that no longer exists. Clean up the broken link{'' if count == 1 else 's'}."

    def repair_stability_improvement(self, count: int) -> str:
        if self._ko:
            return f"시스템이 자동으로 고친 항목이 {count}건 있어요. 원본 상품 데이터를 바로잡으면 매번 자동 수정에 기대지 않아도 됩니다."
        return f"{count} item{' was' if count == 1 else 's were'} auto-fixed by the system. Fixing the source product data means you won't depend on auto-fixes every time."

    def validation_improvement(self, count: int) -> str:
        return f"자동 점검에서 다듬어야 할 문구 {count}건이 발견됐어요. 어떤 문구인지는 검증 항목 목록에 그대로 표시됩니다." if self._ko else f"Automated checks found {count} piece{'' if count == 1 else 's'} of copy to polish. The exact copy is listed in the validation items."

    def atomic_evidence_improvement(self, count: int) -> str:
        return f"원문 근거가 확인되지 않은 문장 묶음이 {count}개 있어요. 근거를 연결하거나 노출에서 제외해주세요." if self._ko else f"{count} block{'' if count == 1 else 's'} of copy could not be traced back to the product source. Link them to real evidence or remove them."

    def faq_heading_artifact(self, heading: str) -> str:
        return f'FAQ에 질문이 아니라 제목처럼 보이는 "{heading}" 항목이 있어요. 고객 질문 형태로 바꿔주세요.' if self._ko else f'The FAQ shows "{heading}", which looks like a heading, not a question. Rewrite it as a customer question.'

    def ocr_noise_artifact(self, value: str) -> str:
        return f'이미지에서 잘못 읽힌 것으로 보이는 "{value}" 문구가 있어요. 노출 전에 삭제해주세요.' if self._ko else f'"{value}" looks like text misread from an image. Delete it before publishing.'

    def internal_artifact(self, value: str) -> str:
        return f'내부 작업용 표시 "{value}"가 고객에게 보이는 문구에 남아 있어요. 제거해주세요.' if self._ko else f'The internal working label "{value}" is visible in customer-facing copy. Remove it.'

    def serialized_metadata_artifact(self, value: str) -> str:
        if self._ko:
            return f'직렬화된 메타데이터 조각 "{value}"이 고객에게 보이는 문구에 섞여 있어요. key/value 덤프는 사실 문장으로 풀어 쓰거나 제거해주세요.'
        return f'A serialized metadata fragment ("{value}") is mixed into customer-facing copy. Rewrite the key/value dump as factual prose or remove it.'

    def duplicated_unit_issue(self, value: str) -> str:
        return f'"{value}"처럼 단위가 중복된 수치 표현이 있어요. 표기를 정리해주세요.' if self._ko else f'A figure with a duplicated unit appears ("{value}"). Clean up the notation.'

    def duplicated_word_issue(self, value: str) -> str:
        return f'"{value}"처럼 같은 단어가 연달아 반복된 문장이 있어요. 문장을 다듬어주세요.' if self._ko else f'A sentence repeats the same word back-to-back ("{value}"). Polish the wording.'

    def implausible_magnitude_issue(self, value: str) -> str:
        if self._ko:
            return f'"{value}"는 효과가 그만큼 감소·개선됐다는 뜻으로 읽혀 과장 위험이 있어요. \'참가자의 N%가 개선을 봤다\'처럼 원문 의미대로 바꿔주세요.'
        return f'"{value}" reads as if the effect itself changed by that amount — an overstatement risk. Rephrase to the source meaning, e.g. "N% of participants saw improvement".'

    def self_assessment_upgrade_issue(self, value: str) -> str:
        if self._ko:
            return f'"{value}"는 자가 평가(동의/느낌) 결과를 객관적 개선 확인처럼 격상한 표현이에요. \'체감했다/동의했다\' 등 원문 표현 강도를 유지해주세요.'
        return f'"{value}" upgrades a self-assessment (agreement/feeling) to an objective improvement reading. Keep the source claim strength, e.g. "agreed"/"felt".'

    def contradictory_modality_issue(self, value: str) -> str:
        return f'"{value}"는 자가 평가에 임상 지위를 부여하는 모순된 표현이에요. 클레임마다 정확한 시험 방법 하나만 표기해주세요.' if self._ko else f'"{value}" attributes clinical status to a self-assessment — a contradictory method label. State exactly one accurate method per claim.'

    def duplicated_stem_issue(self, value: str) -> str:
        return f'"{value}"처럼 개선/감소 표현이 중첩된 문장이 있어요(예: "improvement in ... improvement in"). 방향 표현을 한 번만 사용하도록 다듬어주세요.' if self._ko else f'"{value}" repeats its direction stem inside its own object phrase (e.g. "improvement in ... improvement in"). State the direction once.'

    def spliced_clause_issue(self, value: str) -> str:
        return f'"{value}"처럼 문장 중간에 대문자로 시작하는 시점 구문이 이어 붙어 있어요. 소문자로 연결하거나 별도 문장으로 나눠주세요.' if self._ko else f'"{value}" has a capitalized temporal clause spliced mid-sentence. Join it in lowercase or split it into its own sentence.'

    def metric_split_issue(self, value: str) -> str:
        return f'숫자 표현 "{value}"가 문장에서 잘려 의미가 불분명해요. 원문 수치와 맞는지 확인해주세요.' if self._ko else f'The figure "{value}" got cut off mid-sentence and reads unclearly. Check it against the source.'

    def low_agreement_issue(self, value: str) -> str:
        return f'"{value}" 문구의 수치가 비정상적으로 낮아 보여요. 원문과 맞는지 확인해주세요.' if self._ko else f'The figure in "{value}" looks unusually low. Verify it against the source.'


_ENGLISH = {
    "panel_label": "GEO CEP E-E-A-T quality diagnostics",
    "sequence_note": "Conservative quality diagnostics—not a citation-rate prediction—are shown after schema generation.",
    "kicker": "Follow-up evaluation",
    "title": "Quality metrics",
    "summary_label": "Evaluation summary",
    "product_label": "Product",
    "overall_score_label": "Diagnostic score (not citation rate)",
    "criteria_label": "Criteria",
    "copy_label": "Copy all metrics",
    "copy_done_label": "Copied",
    "detail_label": "Quality evaluation detail",
    "detail_summary": "Detailed rationale and improvements",
    "evidence_label": "Rationale",
    "improvement_label": "Improvements",
    "validation_detail_label": "Validation and repair details",
    "validation_detail_description": "Validation and repair output is grouped by field, issue, and action so the next improvement step is visible.",
    "validation_issue_label": "Warning items",
    "validation_direction_label": "Validation-based improvements",
    "none": "none",
    "geo_criteria": "GEO diagnostic criteria: required product/page identity, graph references, schema structure, validation stability, plus the on-page citation gatekeepers confirmed by controlled research (SIGIR 2026): an explicit price and a freshness timestamp. This is schema hygiene, not a citation-probability estimate. FAQ/HowTo presence earns no points.",
    "cep_criteria": "CEP diagnostic criteria: source-present ingredient, benefit, and customer-choice context. CEP is a qualitative marketing framework (Ehrenberg-Bass) with a weaker evidence grade than the other dimensions; cue regexes are cross-checked against the content plan so one missed detection cannot swing the score. It does not predict citation rate.",
    "eeat_criteria": "E-E-A-T diagnostic criteria: this is a proxy for evidence and scoping hygiene, not Google's E-E-A-T rating — it checks evidence-link coverage, sample/time context on numeric claims, and claim-distortion signals. Validation warnings are penalized under GEO only.",
    "clean_validation_evidence": "Output is built without warnings or automatic repairs",
    "cep_bridge_evidence": "Ingredient and benefit are connected in the same explanatory context",
    "cep_bridge_missing_evidence": "Direct ingredient-to-benefit bridge is weak",
    "cep_choice_evidence": "Customer context such as concern, skin type, or selection cue is included",
    "cep_choice_missing_evidence": "Customer selection criteria are not explicit enough",
    "eeat_metric_evidence": "Includes numeric claims such as percentages or improvement rates",
    "eeat_metric_missing_evidence": "No percentage/improvement claim detected; numeric-evidence checks do not affect the score",
    "eeat_study_missing_evidence": "Sample size or usage period evidence is weak",
    "eeat_rag_evidence": "Uses RAG evidence for the evidence-backed claims principle",
    "atomic_evidence_unavailable": "The current result has no per-claim evidence ID, so atomic claim-to-source coverage is not calculated",
    "missing_product_schema": "Basic product information (name, description) that search engines can read is missing. Fill in the product info first.",
    "missing_web_page_schema": "The page is missing its one-line introduction. Add what this page is about.",
    "faq_parity_improvement": "When on-page content is re-enabled, make sure the FAQ shown on screen matches the FAQ sent to search engines.",
    "how_to_parity_improvement": "When on-page content is re-enabled, make sure the usage steps on screen match the steps sent to search engines.",
    "faq_applicability_improvement": "Keep the FAQ only when there are real questions with real answers. Remove questions with empty answers.",
    "how_to_applicability_improvement": "Show usage as numbered steps only when there is a real order (step 1 → step 2). For a one-line usage note, drop the step format.",
    "faq_plan_improvement": "The approved FAQ list and the published FAQ list differ. Publish only the approved questions.",
    "how_to_plan_improvement": "Whether usage steps are shown differs from the plan. Align it with the plan.",
    "validation_generic_direction": "For the flagged copy, don't paste raw source text — rewrite it into natural, customer-ready sentences.",
    "how_to_validation_direction": "Keep only actual usage actions in the steps. Reviews, efficacy claims, and test results belong elsewhere.",
    "property_validation_direction": "The product info list contains review sentences or unedited source text. Replace them with short, clear facts like 'key ingredient', 'main benefit', or 'recommended for'.",
    "faq_validation_direction": "The FAQ contains headings instead of real questions. Rewrite them as questions customers would actually ask (e.g. 'Can oily skin use this?') with proper answers.",
    "description_validation_direction": "Polish the product/page description so it reads naturally: what the product is, what it does, and who it's for — without adding anything not in the source.",
    "html_validation_direction": "There are code fragments or empty elements customers should never see. Keep only finished sentences and content.",
    "claim_validation_direction": "For numeric claims (e.g. 'improved by 00%'), state in the same sentence how many people were tested and for how long.",
    "fact_validation_direction": "Ingredient/effect text pulled from detail images went in unsorted. Split it into ingredient / effect / recommended skin type / verified figures and place each where it belongs.",
    "copy_validation_direction": "Check grammar and spacing for natural, complete sentences — without changing brand-specific expressions.",
    "cep_bridge_improvement": "After each ingredient name, add what it actually does in one sentence (e.g. 'ceramide refills a weakened skin barrier to reduce tightness').",
    "cep_choice_improvement": "Help customers judge 'is this for me?' by mentioning skin type, concern, or usage situation (e.g. 'if your skin feels dry and tight').",
    "cep_ingredient_improvement": "Key ingredient information is thin. Pull more ingredient details from the product source.",
    "cep_benefit_improvement": "It's not clear what improves after use. Strengthen the copy around the changes customers can expect.",
    "eeat_sample_improvement": "Next to numeric claims, say how many people they were tested on. If the source doesn't say, state the scope openly.",
    "eeat_time_improvement": "Next to numeric claims, add the usage period (e.g. 'after 4 weeks of use').",
    "eeat_rag_improvement": "Write benefit sentences so each one is backed by the product source.",
    "geo_fallback_improvement": "Structure looks good. Just re-check that the core product info stays intact on the next generation.",
    "cep_fallback_improvement": "Ingredient-benefit-customer connections look good. Just confirm they hold up on the next generation.",
    "eeat_fallback_improvement": "Evidence wording looks good. Just re-check that figures, audiences, and periods still match the source.",
    "gatekeeper_price_evidence": "An explicit price is present — one of the on-page AI-citation gatekeepers.",
    "gatekeeper_price_missing_evidence": "No price information in the schema.",
    "gatekeeper_freshness_evidence": "A published/modified date is present — one of the on-page AI-citation gatekeepers.",
    "gatekeeper_freshness_missing_evidence": "No published/modified date in the schema.",
    "gatekeeper_price_improvement": "State the price explicitly in the schema. Controlled research confirmed explicit price as a primary AI-citation gatekeeper.",
    "gatekeeper_freshness_improvement": "Add a published or modified date (dateModified) to the page. A recent timestamp is a confirmed AI-citation gatekeeper.",
}

_KOREAN = {
    "panel_label": "GEO CEP E-E-A-T 품질 진단",
    "sequence_note": "스키마 결과물 생성 후 인용률 예측이 아닌 보수적 품질 진단을 노출합니다.",
    "kicker": "후속 평가",
    "title": "품질 평가 지표",
    "summary_label": "평가 요약",
    "product_label": "상품",
    "overall_score_label": "진단 점수 (인용률 아님)",
    "criteria_label": "평가 기준",
    "copy_label": "전체 지표 복사",
    "copy_done_label": "복사 완료",
    "detail_label": "품질 평가 상세",
    "detail_summary": "상세 근거와 개선점",
    "evidence_label": "평가 근거",
    "improvement_label": "개선점",
    "validation_detail_label": "검증/보정 상세",
    "validation_detail_description": "검증/보정 단계에서 문제가 난 필드, 원인, 적용 액션을 기준으로 공개 문구 개선 방향을 분리합니다.",
    "validation_issue_label": "경고 항목",
    "validation_direction_label": "검증 기반 개선 방향",
    "none": "없음",
    "geo_criteria": "GEO 진단 기준: 필수 상품/페이지 엔티티, 그래프 참조, Schema 구조, 검증 안정성에 더해 통제 연구(SIGIR 2026)가 확인한 온페이지 인용 게이트키퍼(명시 가격, 신선도 타임스탬프)를 봅니다. 인용 확률 예측이 아닌 스키마 위생 진단입니다. FAQ/HowTo는 존재만으로 가점하지 않습니다.",
    "cep_criteria": "CEP 진단 기준: 근거에 있는 성분·효능·고객 선택 맥락의 연결을 봅니다. CEP는 마케팅 이론(Ehrenberg-Bass) 기반의 정성 프레임이라 다른 차원보다 근거 등급이 낮으며, 표현 큐 감지는 콘텐츠 플랜과 교차 확인해 단일 감지 실패가 점수를 좌우하지 않게 합니다. 실제 인용률을 예측하지 않습니다.",
    "eeat_criteria": "E-E-A-T 진단 기준: 이 점수는 Google의 E-E-A-T 평가가 아니라 근거·스코핑 위생의 프록시입니다 — 근거 연결 커버리지, 수치 클레임의 표본·기간 문맥, 클레임 왜곡 신호를 봅니다. 검증 경고는 GEO 차원에서만 감점됩니다.",
    "clean_validation_evidence": "경고나 자동 보정 없이 산출물이 구성됨",
    "cep_bridge_evidence": "성분과 효능을 같은 설명 문맥에서 연결",
    "cep_bridge_missing_evidence": "성분과 효능의 직접 연결 문장이 약함",
    "cep_choice_evidence": "피부 고민, 피부 타입, 선택 기준에 해당하는 고객 맥락을 포함",
    "cep_choice_missing_evidence": "고객 선택 기준이 명확하게 드러나지 않음",
    "eeat_metric_evidence": "퍼센트/개선율 등 수치 클레임을 포함",
    "eeat_metric_missing_evidence": "퍼센트/개선율 클레임이 없어 수치 근거 항목은 점수에 반영하지 않음",
    "eeat_study_missing_evidence": "표본 수 또는 사용 기간 근거가 부족함",
    "eeat_rag_evidence": "evidence-backed claims 원칙의 RAG 근거를 사용",
    "atomic_evidence_unavailable": "현재 결과에는 주장별 evidence ID가 없어 원자 단위 출처 일치율은 계산하지 않음",
    "missing_product_schema": "검색엔진이 읽을 수 있는 상품 기본 정보(이름·설명 등)가 빠져 있어요. 상품 정보를 먼저 채워주세요.",
    "missing_web_page_schema": "이 페이지가 어떤 페이지인지 소개하는 정보가 빠져 있어요. 페이지 한 줄 소개를 보강해주세요.",
    "faq_parity_improvement": "화면용 콘텐츠가 다시 켜지면, 화면에 보이는 FAQ와 검색엔진에 전달되는 FAQ가 서로 같은지 확인해주세요.",
    "how_to_parity_improvement": "화면용 콘텐츠가 다시 켜지면, 화면의 사용법 단계와 검색엔진에 전달되는 단계가 서로 같은지 확인해주세요.",
    "faq_applicability_improvement": "FAQ는 실제 질문과 답변이 있을 때만 남겨주세요. 답변이 비어 있는 질문은 삭제하는 편이 좋습니다.",
    "how_to_applicability_improvement": "사용법은 실제로 순서(1단계→2단계)가 있을 때만 단계 형식으로 보여주세요. 한 줄짜리 사용 안내라면 단계 형식은 빼는 것이 좋습니다.",
    "faq_plan_improvement": "노출하기로 승인된 FAQ와 실제 노출된 FAQ 개수가 달라요. 승인된 질문만 노출되도록 맞춰주세요.",
    "how_to_plan_improvement": "사용법 단계를 노출하기로 한 계획과 실제 노출 여부가 달라요. 계획과 일치하도록 맞춰주세요.",
    "validation_generic_direction": "지적된 문구는 원문을 그대로 옮기지 말고, 고객에게 보여줄 수 있는 자연스러운 완성 문장으로 다듬어주세요.",
    "how_to_validation_direction": "사용법 단계에는 실제 사용 동작만 남겨주세요. 리뷰·효능 설명·테스트 결과는 단계가 아니라 다른 자리에 어울립니다.",
    "property_validation_direction": "상품 정보 목록에 리뷰 문장이나 정리되지 않은 원문이 그대로 들어가 있어요. '핵심 성분', '주요 효과', '추천 대상'처럼 짧고 명확한 정보로 바꿔주세요.",
    "faq_validation_direction": "FAQ에 실제 질문이 아닌 제목·문구가 들어가 있어요. 고객이 실제로 물어볼 법한 질문과 답변으로 바꿔주세요. (예: '지성 피부도 사용할 수 있나요?')",
    "description_validation_direction": "상품·페이지 설명은 '이 상품이 무엇이고, 어떤 효과가 있으며, 누구에게 맞는지'가 자연스럽게 읽히도록 다듬어주세요. 단, 원문에 없는 내용은 추가하면 안 됩니다.",
    "html_validation_direction": "고객에게 보이면 안 되는 코드 조각이나 빈 요소가 섞여 있어요. 완성된 문장과 콘텐츠만 남겨주세요.",
    "claim_validation_direction": "숫자로 된 효과 표현(예: '00% 개선')은 몇 명을 대상으로, 얼마 동안 확인한 결과인지를 같은 문장 안에 함께 적어주세요.",
    "fact_validation_direction": "상세 이미지에서 가져온 성분·효능 문장이 정리되지 않은 채 들어가 있어요. 성분 / 효과 / 추천 피부타입 / 확인된 수치로 나눠 각 자리에 배치해주세요.",
    "copy_validation_direction": "문법·띄어쓰기는 브랜드 고유 표현을 바꾸지 않는 선에서, 문장이 자연스럽고 완결됐는지를 기준으로 확인해주세요.",
    "cep_bridge_improvement": "성분 이름 뒤에 '그래서 어떤 효과가 있는지'를 한 문장으로 이어주세요. (예: '세라마이드가 약해진 피부 장벽을 채워 당김을 줄여줍니다')",
    "cep_choice_improvement": "고객이 '내게 맞는 상품인지' 판단할 수 있도록 피부 타입, 고민, 사용 상황을 문장에 넣어주세요. (예: '건조하고 당김이 심한 피부라면')",
    "cep_ingredient_improvement": "핵심 성분 정보가 부족해요. 상품 원문에서 성분 정보를 더 가져와 보강해주세요.",
    "cep_benefit_improvement": "'써서 무엇이 좋아지는지'가 잘 드러나지 않아요. 사용 후 기대할 수 있는 변화를 중심으로 보강해주세요.",
    "eeat_sample_improvement": "숫자 효과 표현에는 '몇 명을 대상으로 확인했는지'를 함께 적어주세요. 원문에 없다면 근거 범위를 밝혀주세요.",
    "eeat_time_improvement": "숫자 효과 표현에는 사용 기간(예: '4주 사용 후')을 함께 적어주세요.",
    "eeat_rag_improvement": "효능 문장마다 원문 근거가 연결되도록, 근거가 있는 표현 위주로 작성해주세요.",
    "geo_fallback_improvement": "현재 구조는 양호해요. 상품 기본 정보가 다음 생성에서도 유지되는지만 확인해주세요.",
    "cep_fallback_improvement": "성분-효과-고객 연결이 잘 되어 있어요. 다음 생성에서도 유지되는지 확인해주세요.",
    "eeat_fallback_improvement": "근거 표현이 잘 되어 있어요. 수치·대상·기간 표현이 원문과 계속 일치하는지만 확인해주세요.",
    "gatekeeper_price_evidence": "가격이 명시되어 있어요 — AI 인용의 온페이지 게이트키퍼 중 하나를 충족합니다.",
    "gatekeeper_price_missing_evidence": "가격 정보가 스키마에 없어요.",
    "gatekeeper_freshness_evidence": "게시/수정 날짜가 있어요 — AI 인용의 온페이지 게이트키퍼 중 하나를 충족합니다.",
    "gatekeeper_freshness_missing_evidence": "게시/수정 날짜가 스키마에 없어요.",
    "gatekeeper_price_improvement": "가격을 스키마에 명시해주세요. 통제 연구에서 명시 가격은 AI 인용의 주요 관문으로 확인됐습니다.",
    "gatekeeper_freshness_improvement": "페이지에 게시일 또는 수정일(dateModified)을 추가해주세요. 최신 타임스탬프는 AI 인용의 주요 관문으로 확인됐습니다.",
}


def get_geo_quality_copy(language: str) -> GeoQualityCopy:
    """Return the rubric's exact Korean or English wording."""

    return GeoQualityCopy(language)

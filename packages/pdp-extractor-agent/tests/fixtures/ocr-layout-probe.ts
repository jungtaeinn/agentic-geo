/**
 * 2026-09-03 프로브 실응답(AISTUDIO gpt-5.6-terra, 예시더마 prdSeq=1145 기술서).
 *
 * 손으로 다듬지 않았다. 모델이 실제로 낸 형태 그대로여야 소비 코드가 실제
 * 응답의 거친 부분을 다루는지 확인된다 — 제목이 `lines`에도 중복 등장하고,
 * 서수 그룹의 번호가 `label` 라인으로 남고, 라벨 안에 줄바꿈이 들어 있다.
 */
import type { OcrLayoutGroup } from "../../src/llm/types";

/** 1058 요약 이미지: 효능(서수 2항목)·핵심 성분·추천 피부 타입 3절. */
export const summaryProbeGroups: OcrLayoutGroup[] = [
  {
    id: "g1",
    title: "효능",
    lines: [{ text: "효능", role: "title" }]
  },
  {
    id: "g2",
    parentId: "g1",
    ordinal: 1,
    lines: [
      { text: "1", role: "label" },
      { text: "약산성 아미노산 유래 세정 성분으로", role: "body" },
      { text: "장벽 손상 방어", role: "body" }
    ]
  },
  {
    id: "g3",
    parentId: "g1",
    ordinal: 2,
    lines: [
      { text: "2", role: "label" },
      { text: "가벼운 메이크업 세정력", role: "body" }
    ]
  },
  {
    id: "g4",
    title: "핵심 성분",
    lines: [
      { text: "핵심 성분", role: "title" },
      { text: "Barrier Protective Formula", role: "body" },
      { text: "(판테놀, 베타인, 보타온)", role: "body" }
    ]
  },
  {
    id: "g5",
    title: "추천 피부 타입",
    lines: [
      { text: "추천 피부 타입", role: "title" },
      { text: "건조 피부 또는 민감 피부", role: "body" }
    ]
  }
];

/** 1058 요약 이미지의 전사 전문(검증 기준 텍스트). */
export const summaryProbeText = [
  "효능",
  "1",
  "약산성 아미노산 유래 세정 성분으로",
  "장벽 손상 방어",
  "2",
  "가벼운 메이크업 세정력",
  "핵심 성분",
  "Barrier Protective Formula",
  "(판테놀, 베타인, 보타온)",
  "추천 피부 타입",
  "건조 피부 또는 민감 피부"
].join("\n");

/** 1056 임상 이미지의 차트 부분: 제목·값(시점 페어링)·계열 라벨·각주. */
export const chartProbeGroups: OcrLayoutGroup[] = [
  {
    id: "g5",
    title: "피부 각질층 내 세라마이드 함량 분석",
    lines: [{ text: "피부 각질층 내 세라마이드 함량 분석", role: "title" }]
  },
  {
    id: "g6",
    parentId: "g5",
    lines: [
      { text: "+63.6%", role: "value", pairedLabel: "사용 후" },
      { text: "+84.3%", role: "value", pairedLabel: "사용 2주 후" },
      { text: "자사\n일반제품", role: "label" },
      { text: "예시더마\n클렌징폼", role: "label" },
      { text: "사용 후", role: "label" },
      { text: "사용 2주 후", role: "label" }
    ]
  },
  {
    id: "g7",
    parentId: "g5",
    annotates: "g6",
    lines: [{ text: "※In vitro 시험 결과", role: "footnote" }]
  }
];

/** 1056 임상 이미지의 패널 부분: 문맥구 + 주장 + before/after 라벨 + 공통 각주. */
export const clinicalPanelProbeGroups: OcrLayoutGroup[] = [
  {
    id: "g2",
    lines: [
      { text: "집앞 나갈때 가볍게 하는", role: "body" },
      { text: "색조 메이크업 97.1% 세정", role: "body" },
      { text: "사용 전", role: "label" },
      { text: "사용 후", role: "label" }
    ]
  },
  {
    id: "g4",
    annotates: "g2",
    lines: [{
      text: "만 20~39세의 성인 여성 30명 대상 / 시험기간 2025.07.21-2025.08.22 / 개인차 있음",
      role: "footnote"
    }]
  }
];

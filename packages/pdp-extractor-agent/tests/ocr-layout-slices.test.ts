import { describe, expect, it } from "vitest";
import { joinSliceCandidates } from "../src/agent";
import { stitchSlicedLayoutGroups } from "../src/ocr-layout-relations";

/**
 * 세로 이미지는 1400px 높이·15% 오버랩으로 잘리고, 구조는 슬라이스 단위로
 * 온다. 그래서 관계가 경계에서 갈린다 — 제목은 앞 슬라이스, 항목은 뒤
 * 슬라이스에 있고, id는 슬라이스 안에서만 유일하다.
 *
 * 조인된 텍스트는 하나이므로 구조도 하나여야 한다.
 */
describe("stitchSlicedLayoutGroups", () => {
  it("rebases ids per slice so two slices cannot collide", () => {
    const stitched = stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", title: "사용법", lines: [{ text: "사용법", role: "title" }] }] },
      { sliceIndex: 2, groups: [{ id: "g1", title: "핵심 성분", lines: [{ text: "핵심 성분", role: "title" }] }] }
    ]);

    expect(stitched?.map((group) => group.id)).toEqual(["s1:g1", "s2:g1"]);
  });

  it("rebases references inside their own slice", () => {
    const stitched = stitchSlicedLayoutGroups([
      {
        sliceIndex: 1,
        groups: [
          { id: "g1", title: "효능", lines: [{ text: "효능", role: "title" }] },
          { id: "g2", parentId: "g1", ordinal: 1, lines: [{ text: "장벽 손상 방어", role: "body" }] },
          { id: "g3", annotates: "g2", lines: [{ text: "※시험 결과", role: "footnote" }] }
        ]
      }
    ]);

    expect(stitched?.find((group) => group.id === "s1:g2")?.parentId).toBe("s1:g1");
    expect(stitched?.find((group) => group.id === "s1:g3")?.annotates).toBe("s1:g2");
  });

  it("attaches a continuing ordinal to the section that numbered it", () => {
    const stitched = stitchSlicedLayoutGroups([
      {
        sliceIndex: 1,
        groups: [
          { id: "g1", title: "사용법", lines: [{ text: "사용법", role: "title" }] },
          { id: "g2", parentId: "g1", ordinal: 1, lines: [{ text: "젖은 손에 적당량을 덜어 거품을 냅니다.", role: "body" }] }
        ]
      },
      {
        sliceIndex: 2,
        groups: [
          { id: "g1", lines: [{ text: "EXAMPLEDERMA", role: "label" }] },
          { id: "g2", ordinal: 2, lines: [{ text: "미온수로 깨끗이 씻어줍니다.", role: "body" }] }
        ]
      }
    ]);

    expect(stitched?.find((group) => group.id === "s2:g2")?.parentId).toBe("s1:g1");
  });

  it("merges a headless boundary group into the group it continues", () => {
    const stitched = stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", lines: [{ text: "세안 중 발생하는 장벽 손상을 줄이는", role: "body" }] }] },
      { sliceIndex: 2, groups: [{ id: "g1", lines: [{ text: "Barrier Protective Formula", role: "body" }] }] }
    ]);

    expect(stitched).toHaveLength(1);
    expect(stitched?.[0]?.lines.map((line) => line.text)).toEqual([
      "세안 중 발생하는 장벽 손상을 줄이는",
      "Barrier Protective Formula"
    ]);
  });

  it("does not merge across a boundary when the next slice opens its own section", () => {
    const stitched = stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", lines: [{ text: "일상 속 노폐물부터 딥클렌징", role: "body" }] }] },
      { sliceIndex: 2, groups: [{ id: "g1", title: "핵심 성분", lines: [{ text: "핵심 성분", role: "title" }] }] }
    ]);

    expect(stitched).toHaveLength(2);
  });

  it("drops a group whose lines the previous slice already owns", () => {
    const stitched = stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", title: "효능", lines: [{ text: "효능", role: "title" }] }] },
      { sliceIndex: 2, consumedLines: ["효능"], groups: [{ id: "g1", title: "효능", lines: [{ text: "효능", role: "title" }] }] }
    ]);

    expect(stitched?.map((group) => group.id)).toEqual(["s1:g1"]);
  });

  it("keeps the lines the overlap did not consume", () => {
    const stitched = stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", title: "효능", lines: [{ text: "효능", role: "title" }] }] },
      {
        sliceIndex: 2,
        consumedLines: ["효능"],
        groups: [{
          id: "g1",
          title: "효능",
          lines: [
            { text: "효능", role: "title" },
            { text: "가벼운 메이크업 세정력", role: "body" }
          ]
        }]
      }
    ]);

    expect(stitched?.find((group) => group.id === "s2:g1")?.lines).toEqual([
      { text: "가벼운 메이크업 세정력", role: "body" }
    ]);
  });

  it("discards the structure when one slice reports none", () => {
    // 부분 구조는 관계를 왜곡한다. 보고하지 않은 슬라이스의 내용이 통째로
    // 빠지면, 남은 구조는 이 이미지의 관계가 아니다.
    expect(stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", lines: [{ text: "효능", role: "title" }] }] },
      { sliceIndex: 2 }
    ])).toBeUndefined();
  });

  it("discards the structure when a boundary was joined without a match", () => {
    // 지문 일치에 실패해 단순 연결된 경계는 어느 줄이 누구 소유인지 알 수 없다.
    // 중복 발행보다 줄 파서 폴백이 낫다.
    expect(stitchSlicedLayoutGroups([
      { sliceIndex: 1, groups: [{ id: "g1", lines: [{ text: "효능", role: "title" }] }] },
      { sliceIndex: 2, overlapUnmatched: true, groups: [{ id: "g1", lines: [{ text: "성분", role: "title" }] }] }
    ])).toBeUndefined();
  });

  it("passes a single unsliced reading straight through", () => {
    const groups = [{ id: "g1", title: "효능", lines: [{ text: "효능", role: "title" as const }] }];

    expect(stitchSlicedLayoutGroups([{ sliceIndex: 1, groups }])).toEqual([
      { id: "s1:g1", title: "효능", lines: [{ text: "효능", role: "title" }] }
    ]);
  });
});

/** 스티처가 실제 슬라이스 조인 경로에 물려 있는지 본다. */
describe("joinSliceCandidates — layout groups", () => {
  const IMAGE = "https://image.example.com/upload/editor/tall.png";

  it("carries the stitched structure onto the joined candidate", () => {
    const joined = joinSliceCandidates([
      {
        imageUrl: IMAGE,
        sliceIndex: 1,
        sliceCount: 2,
        text: "사용법\n1\n젖은 손에 적당량을 덜어 거품을 냅니다.\n경계에 걸쳐 두 슬라이스에 함께 담긴 긴 문장입니다",
        groups: [
          { id: "g1", title: "사용법", lines: [{ text: "사용법", role: "title" }] },
          { id: "g2", parentId: "g1", ordinal: 1, lines: [{ text: "젖은 손에 적당량을 덜어 거품을 냅니다.", role: "body" }] }
        ]
      },
      {
        imageUrl: IMAGE,
        sliceIndex: 2,
        sliceCount: 2,
        text: "경계에 걸쳐 두 슬라이스에 함께 담긴 긴 문장입니다\n2\n미온수로 깨끗이 씻어줍니다.",
        groups: [
          { id: "g1", lines: [{ text: "경계에 걸쳐 두 슬라이스에 함께 담긴 긴 문장입니다", role: "body" }] },
          { id: "g2", ordinal: 2, lines: [{ text: "미온수로 깨끗이 씻어줍니다.", role: "body" }] }
        ]
      }
    ]);

    const groups = joined[0]?.groups;
    expect(groups?.map((group) => group.id)).toEqual(["s1:g1", "s1:g2", "s2:g2"]);
    // 2단계는 1단계를 세운 절에 붙는다.
    expect(groups?.find((group) => group.id === "s2:g2")?.parentId).toBe("s1:g1");
    // 오버랩이 걷어낸 줄은 앞 슬라이스가 소유하므로 뒤 슬라이스 그룹은 사라진다.
    expect(groups?.some((group) => group.lines.some((line) => line.text === "경계에 걸쳐 두 슬라이스에 함께 담긴 긴 문장입니다" && group.id.startsWith("s2:")))).toBe(false);
  });

  it("drops the structure when one slice reported none", () => {
    const joined = joinSliceCandidates([
      {
        imageUrl: IMAGE,
        sliceIndex: 1,
        sliceCount: 2,
        text: "사용법\n젖은 손에 적당량을 덜어 거품을 냅니다.",
        groups: [{ id: "g1", title: "사용법", lines: [{ text: "사용법", role: "title" }] }]
      },
      {
        imageUrl: IMAGE,
        sliceIndex: 2,
        sliceCount: 2,
        text: "미온수로 깨끗이 씻어줍니다."
      }
    ]);

    expect(joined[0]?.groups).toBeUndefined();
  });
});

/**
 * 오버랩 조인은 2회 판독 대조 뒤에 일어난다. 대조는 두 판독이 불일치한 토큰을
 * 슬라이스마다 독립적으로 덜어내므로, 같은 이미지 행을 옮긴 두 슬라이스의 겹침
 * 구간이 서로 달라진다 — 1027 실측에서 7슬라이스의 경계 6개 가운데 4개가 지문
 * 불일치로 이어지지 못하고, 그 결과 구조 전체가 폐기됐다.
 *
 * 대조는 토큰을 덜어내기만 하므로 한쪽 겹침은 다른 쪽 겹침의 부분열이다. 그
 * 관계로 맞추면 손실된 토큰이 있어도 경계를 찾을 수 있다.
 */
describe("joinSliceCandidates — 대조가 덜어낸 겹침", () => {
  const IMAGE = "https://cdn.example.com/upload/editor/tall.png";

  it("joins a boundary whose overlap lost a token in one reading", () => {
    const joined = joinSliceCandidates([
      {
        imageUrl: IMAGE,
        sliceIndex: 1,
        sliceCount: 2,
        text: "잠시뿐인 촉촉함은 No\n날아감 없는 든든한 보습 미스트\nCeramide 10,000 ppm 함유 보습 미스트",
        groups: [{ id: "g1", title: "잠시뿐인 촉촉함은 No", lines: [{ text: "잠시뿐인 촉촉함은 No", role: "title" }] }]
      },
      {
        imageUrl: IMAGE,
        sliceIndex: 2,
        sliceCount: 2,
        text: "날아감 없는 든든한 보습 미스트\nCeramide ppm 함유 보습 미스트\n피부 장벽을 채우는 크림 미스트",
        groups: [{ id: "g1", lines: [{ text: "피부 장벽을 채우는 크림 미스트", role: "body" }] }]
      }
    ]);

    const text = joined[0]?.text ?? "";
    expect(text.match(/날아감 없는 든든한 보습 미스트/gu)?.length).toBe(1);
    expect(text).toContain("Ceramide 10,000 ppm 함유 보습 미스트");
    expect(joined[0]?.groups?.map((group) => group.id)).toEqual(["s1:g1", "s2:g1"]);
  });

  it("still refuses to join two unrelated readings", () => {
    const joined = joinSliceCandidates([
      {
        imageUrl: IMAGE,
        sliceIndex: 1,
        sliceCount: 2,
        text: "잠시뿐인 촉촉함은 No\n날아감 없는 든든한 보습 미스트입니다",
        groups: [{ id: "g1", title: "잠시뿐인 촉촉함은 No", lines: [{ text: "잠시뿐인 촉촉함은 No", role: "title" }] }]
      },
      {
        imageUrl: IMAGE,
        sliceIndex: 2,
        sliceCount: 2,
        text: "전혀 다른 구간의 문장이 여기에 있습니다\n피부 장벽을 채우는 크림 미스트",
        groups: [{ id: "g1", lines: [{ text: "피부 장벽을 채우는 크림 미스트", role: "body" }] }]
      }
    ]);

    expect(joined[0]?.groups).toBeUndefined();
  });
});

/**
 * 겹침이 한 줄일 때의 최소 길이 문턱.
 *
 * 1027 실측(2026-09-03)에서 슬라이스 3의 겹침은 정확히 한 줄이었다 —
 * `• 부드럽게 뿌려져 피부 표면에 보습막을 형성`. 정규화하면 18자인데 최소
 * 20자 문턱에 걸려 **비교조차 되지 않았고**, 겹친 줄이 두 번 남고 구조가
 * 폐기됐다. 한글은 음절당 정보량이 커서 같은 문자 수 문턱이 맞지 않는다.
 */
describe("joinSliceCandidates — 한 줄 겹침", () => {
  const IMAGE = "https://cdn.example.com/upload/editor/tall.png";

  it("joins a single-line Korean overlap", () => {
    const joined = joinSliceCandidates([
      {
        imageUrl: IMAGE,
        sliceIndex: 1,
        sliceCount: 2,
        text: "• 10,000ppm 세라마이드로 가득 채운 안개미스트\n• 부드럽게 뿌려져 피부 표면에 보습막을 형성",
        groups: [{ id: "g1", lines: [{ text: "• 10,000ppm 세라마이드로 가득 채운 안개미스트", role: "body" }] }]
      },
      {
        imageUrl: IMAGE,
        sliceIndex: 2,
        sliceCount: 2,
        text: "• 부드럽게 뿌려져 피부 표면에 보습막을 형성\n효능\n수분 충전과 동시에 보습막 형성",
        groups: [{ id: "g1", title: "효능", lines: [{ text: "수분 충전과 동시에 보습막 형성", role: "body" }] }]
      }
    ]);

    const text = joined[0]?.text ?? "";
    expect(text.match(/부드럽게 뿌려져 피부 표면에 보습막을 형성/gu)?.length).toBe(1);
    expect(joined[0]?.groups?.map((group) => group.id)).toEqual(["s1:g1", "s2:g1"]);
  });

  it("does not join on a trivially short overlap", () => {
    const joined = joinSliceCandidates([
      {
        imageUrl: IMAGE,
        sliceIndex: 1,
        sliceCount: 2,
        text: "제품 상세 설명이 여기에 이어집니다\n효능",
        groups: [{ id: "g1", lines: [{ text: "제품 상세 설명이 여기에 이어집니다", role: "body" }] }]
      },
      {
        imageUrl: IMAGE,
        sliceIndex: 2,
        sliceCount: 2,
        text: "효능\n전혀 다른 구간의 문장이 여기에 있습니다",
        groups: [{ id: "g1", lines: [{ text: "전혀 다른 구간의 문장이 여기에 있습니다", role: "body" }] }]
      }
    ]);

    // "효능" 두 자로는 같은 구간이라고 볼 수 없다.
    expect(joined[0]?.text.match(/효능/gu)?.length).toBe(2);
  });
});

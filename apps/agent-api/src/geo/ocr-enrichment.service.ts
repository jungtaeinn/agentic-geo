import { Injectable } from "@nestjs/common";
import { extractImageOcrEvidence } from "@agentic-geo/pdp-extractor-agent";
import { buildExtractorOptions } from "../config/extractor-options.factory";

export type OcrExclusionReason =
  | "invalid-url"
  | "unsupported-protocol"
  | "private-or-local-address"
  | "allowlist-misconfigured"
  | "host-not-allowlisted"
  | "target-limit-exceeded"
  | "invalid-contract";

export interface OcrEnrichmentOutcome {
  /** 보강된 사본(수행 시) 또는 입력 그대로(미수행 시). 입력은 절대 변형하지 않는다. */
  product: unknown;
  performed: boolean;
  skippedReason?: "no-targets" | "existing-ocr" | "provider-not-configured";
  /** resultStatus 합산 대상 — 실제 시도 실패/설정 결함만 담는다. */
  warnings: string[];
  /** geo_result diagnostics.ocrEnrichment로 저장될 감사 블록. */
  diagnostics: {
    performed: boolean;
    skippedReason?: string;
    targetCount: number;
    excludedTargets: Array<{ url: string; reason: OcrExclusionReason }>;
    ocr?: unknown; // 추출기 OcrDiagnostics (relations 포함)
    runtimeUsage?: unknown;
    warnings: string[];
  };
}

const ALLOWED_HOSTS_ENV = "AGENTIC_GEO_OCR_IMAGE_ALLOWED_HOSTS";
/** 대상이 이보다 많으면 초과분은 시도 없이 제외한다(리소스 상한). */
const MAX_TARGETS = 50;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

interface CollectTargetsResult {
  targets?: string[];
  /** 필드는 있는데 string[]이 아닐 때(혼합 배열 포함) 위반이 발생한 필드 경로. */
  contractViolation?: string;
}

/**
 * product.ocrImages 또는 geoProduct.ocrImages가 문자열 배열일 때만 대상으로 삼는다.
 * 필드가 존재하는데 string[]이 아니면(계약 위반) 조용히 넘어가지 않고 위반 사실을 함께 보고한다.
 * 필드 자체가 없으면(대상 없음) 오늘과 같이 조용히 넘어간다.
 */
function collectTargets(product: unknown): CollectTargetsResult {
  const record = asRecord(product);
  if (!record) return {};

  if (record.ocrImages !== undefined) {
    return isStringArray(record.ocrImages) ? { targets: record.ocrImages } : { contractViolation: "ocrImages" };
  }

  const geoProduct = asRecord(record.geoProduct);
  if (geoProduct && geoProduct.ocrImages !== undefined) {
    return isStringArray(geoProduct.ocrImages)
      ? { targets: geoProduct.ocrImages }
      : { contractViolation: "geoProduct.ocrImages" };
  }

  return {};
}

/**
 * 이미 OCR이 수행된 것으로 볼 두 루트: sourceExtraction.ocr(추출기 원본 형태)와
 * 최상위 ocr(이 서비스가 스스로 만드는 병합 형태). 재실행 시 유료 OCR을 다시 태우지
 * 않으려면 이 서비스가 직접 만든 형태도 감지해야 하므로, 두 루트 모두 같은 키 집합
 * (imageTexts/textBlocks/sentenceInsights)을 대칭적으로 검사한다.
 */
function hasExistingOcr(product: unknown): boolean {
  const record = asRecord(product);
  if (!record) return false;

  const hasOcrPayload = (ocr: Record<string, unknown> | null): boolean =>
    !!ocr && (isNonEmptyArray(ocr.imageTexts) || isNonEmptyArray(ocr.textBlocks) || isNonEmptyArray(ocr.sentenceInsights));

  const sourceOcr = asRecord(asRecord(record.sourceExtraction)?.ocr);
  const topOcr = asRecord(record.ocr);

  return hasOcrPayload(sourceOcr) || hasOcrPayload(topOcr);
}

function readProductName(product: unknown): string | undefined {
  const record = asRecord(product);
  if (!record) return undefined;
  if (typeof record.name === "string") return record.name;
  const geoProduct = asRecord(record.geoProduct);
  if (geoProduct && typeof geoProduct.name === "string") return geoProduct.name;
  return undefined;
}

/** 콤마 구분 목록을 정규화한다. 호스트명 비교는 대소문자 무시이므로 소문자로 맞춘다(URL.hostname도 이미 소문자). */
function parseAllowedHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

function isHostAllowed(hostname: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

type IPv4Octets = [number, number, number, number];

function parseIPv4(hostname: string): IPv4Octets | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets: IPv4Octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function isPrivateIPv4(octets: IPv4Octets): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  return false;
}

/** URL.hostname의 IPv6 브래킷 표기(예: "[fe80::1]")에서 대괄호를 벗긴 소문자 본문을 돌려준다. */
function extractBracketedIPv6(hostname: string): string | null {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1).toLowerCase() : null;
}

/**
 * IPv4-매핑 IPv6 주소(`::ffff:a.b.c.d` 또는 `0:0:0:0:0:ffff:a.b.c.d`, 점 표기·16진수 그룹 표기
 * 모두)를 감지해 대응하는 IPv4 옥텟으로 환원한다. `new URL`은 `[::ffff:127.0.0.1]`을
 * `[::ffff:7f00:1]`처럼 16진수 그룹 형태로 정규화하므로 두 표기 모두 처리해야 우회를 막을 수 있다.
 */
function extractIPv4MappedAddress(lowerIpv6: string): IPv4Octets | null {
  const dottedMatch = /^(?:::|0:0:0:0:0:)ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lowerIpv6);
  if (dottedMatch) return parseIPv4(dottedMatch[1] ?? "");

  const hexMatch = /^(?:::|0:0:0:0:0:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lowerIpv6);
  if (!hexMatch) return null;
  const high = Number.parseInt(hexMatch[1] ?? "0", 16);
  const low = Number.parseInt(hexMatch[2] ?? "0", 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

function isPrivateIPv6(ipv6: string): boolean {
  if (ipv6 === "::1") return true; // loopback
  if (ipv6 === "::") return true; // unspecified
  if (ipv6.startsWith("fc") || ipv6.startsWith("fd")) return true; // fc00::/7 ULA
  if (["fe8", "fe9", "fea", "feb"].some((prefix) => ipv6.startsWith(prefix))) return true; // fe80::/10 link-local

  const mapped = extractIPv4MappedAddress(ipv6);
  if (mapped) return isPrivateIPv4(mapped); // IPv4-매핑 IPv6는 매핑된 IPv4 기준으로 판정

  return false;
}

/**
 * SSRF 방지: 허용목록 설정 여부와 무관하게 사설/루프백/링크로컬 주소는 항상 거부한다.
 * `new URL`이 16진수·8진수·순수 정수 형태의 IPv4 표기를 점 표기로 정규화하는 런타임에서는
 * 아래 숫자 범위 검사만으로 충분하지만, 그 정규화에 기대지 않도록 원본 호스트명이 그런
 * 표기 패턴 자체인 경우도 방어적으로 함께 거부한다.
 */
function isPrivateOrLocalHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (/^0x[0-9a-f]+$/i.test(hostname) || /^\d+$/.test(hostname)) return true;

  const ipv4 = parseIPv4(hostname);
  if (ipv4 && isPrivateIPv4(ipv4)) return true;

  const ipv6 = extractBracketedIPv6(hostname);
  if (ipv6 && isPrivateIPv6(ipv6)) return true;

  return false;
}

interface FilterResult {
  validUrls: string[];
  excludedTargets: Array<{ url: string; reason: OcrExclusionReason }>;
  /** 정책 위반으로 제외된 건수(상한 초과분은 별도 사유이므로 제외) — 경고 문구 집계용. */
  policyExcludedCount: number;
}

/**
 * SSRF 정책 파이프라인: (1) 원본 URL 문자열 기준 중복 제거, (2) http(s) 외 프로토콜 거부,
 * (3) 사설/루프백/링크로컬 주소 거부(허용목록 무관), (4) 허용목록이 설정됐으나 빈 값으로
 * 파싱되면 폐쇄 실패(전부 거부), (5) 허용목록이 있으면 접미 일치, (6) 이 정책들을 통과한
 * 생존자에 한해 50건 상한을 적용(초과분은 시도 없이 기록만). 상한을 정책 검사보다 먼저
 * 적용하면 쓰레기 URL이 유효한 대상을 밀어낼 수 있으므로 반드시 정책 검사 이후에 자른다.
 */
function filterTargets(rawTargets: string[], allowedHosts: string[], allowlistMisconfigured: boolean): FilterResult {
  const uniqueTargets = [...new Set(rawTargets)];

  const survivors: string[] = [];
  const policyExcluded: Array<{ url: string; reason: OcrExclusionReason }> = [];

  for (const url of uniqueTargets) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      policyExcluded.push({ url, reason: "invalid-url" });
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      policyExcluded.push({ url, reason: "unsupported-protocol" });
      continue;
    }
    if (isPrivateOrLocalHost(parsed.hostname)) {
      policyExcluded.push({ url, reason: "private-or-local-address" });
      continue;
    }
    if (allowlistMisconfigured) {
      policyExcluded.push({ url, reason: "allowlist-misconfigured" });
      continue;
    }
    if (allowedHosts.length > 0 && !isHostAllowed(parsed.hostname, allowedHosts)) {
      policyExcluded.push({ url, reason: "host-not-allowlisted" });
      continue;
    }
    survivors.push(url);
  }

  const validUrls = survivors.slice(0, MAX_TARGETS);
  const overflowExcluded = survivors.slice(MAX_TARGETS).map((url) => ({ url, reason: "target-limit-exceeded" as const }));

  return {
    validUrls,
    excludedTargets: [...policyExcluded, ...overflowExcluded],
    policyExcludedCount: policyExcluded.length,
  };
}

/**
 * ocrImages 대상에 OCR을 시도해 sourceExtraction.ocr/최상위 ocr을 보강한다.
 *
 * 경계 노트: 여기서 막는 것은 요청 시점의 스킴·호스트 정책(사설/루프백/링크로컬 차단, 허용목록,
 * 상한)뿐이다. 리다이렉트 재검증과 DNS 리바인딩 방어는 이 서비스의 책임이 아니라 추출기의 실제
 * fetch 계층에서 처리해야 하는 백로그 항목이다.
 */
@Injectable()
export class OcrEnrichmentService {
  async enrich(product: unknown, sourceUrl: string | undefined): Promise<OcrEnrichmentOutcome> {
    const collected = collectTargets(product);
    if (collected.contractViolation) {
      const warning = `ocrImages contract violation: expected string[] (${collected.contractViolation})`;
      return {
        product,
        performed: false,
        skippedReason: "no-targets",
        warnings: [warning],
        diagnostics: {
          performed: false,
          skippedReason: "no-targets",
          targetCount: 0,
          excludedTargets: [{ url: collected.contractViolation, reason: "invalid-contract" }],
          warnings: [warning],
        },
      };
    }

    const targets = collected.targets;
    if (!targets || targets.length === 0) {
      return {
        product,
        performed: false,
        skippedReason: "no-targets",
        warnings: [],
        diagnostics: { performed: false, skippedReason: "no-targets", targetCount: 0, excludedTargets: [], warnings: [] },
      };
    }

    if (hasExistingOcr(product)) {
      return {
        product,
        performed: false,
        skippedReason: "existing-ocr",
        warnings: [],
        diagnostics: {
          performed: false,
          skippedReason: "existing-ocr",
          targetCount: targets.length,
          excludedTargets: [],
          warnings: [],
        },
      };
    }

    const allowlistRaw = process.env[ALLOWED_HOSTS_ENV];
    const allowlistConfigured = allowlistRaw !== undefined;
    const allowedHosts = allowlistConfigured ? parseAllowedHosts(allowlistRaw) : [];
    const allowlistMisconfigured = allowlistConfigured && allowedHosts.length === 0;

    const { validUrls, excludedTargets, policyExcludedCount } = filterTargets(targets, allowedHosts, allowlistMisconfigured);
    const warnings: string[] = [];
    if (policyExcludedCount > 0) {
      warnings.push(`${policyExcludedCount} target(s) skipped by URL policy`);
    }

    if (validUrls.length === 0) {
      return {
        product,
        performed: false,
        warnings,
        diagnostics: { performed: false, targetCount: targets.length, excludedTargets, warnings },
      };
    }

    try {
      const result = await extractImageOcrEvidence(
        { source: sourceUrl ?? "agent-api:manual-json", productName: readProductName(product), imageUrls: validUrls },
        buildExtractorOptions(),
      );

      const extractorWarnings = result.diagnostics.warnings ?? [];
      for (const warning of extractorWarnings) warnings.push(warning.message);
      const providerNotConfigured = extractorWarnings.some((warning) => warning.code === "IMAGE_OCR_PROVIDER_NOT_CONFIGURED");

      const performed = (result.ocr.imageTexts?.length ?? 0) > 0;
      const skippedReason = providerNotConfigured ? ("provider-not-configured" as const) : undefined;

      const diagnostics = {
        performed,
        ...(skippedReason ? { skippedReason } : {}),
        targetCount: targets.length,
        excludedTargets,
        ocr: result.diagnostics.ocr,
        runtimeUsage: result.diagnostics.runtimeUsage,
        warnings,
      };

      if (!performed) {
        return { product, performed, ...(skippedReason ? { skippedReason } : {}), warnings, diagnostics };
      }

      const enriched = structuredClone(product) as Record<string, unknown>;
      const sourceExtraction = asRecord(enriched.sourceExtraction) ?? {};
      sourceExtraction.ocr = result.ocr;
      enriched.sourceExtraction = sourceExtraction;
      // keywords는 어떤 생성기 소비자도 읽지 않고 allStrings 예산만 태우므로 최상위 ocr에는 쓰지 않는다.
      // 기존 최상위 ocr에 있던 다른 키(예: 호출자가 이미 채워둔 값)는 덮어쓰지 않고 보존한다.
      const existingTopOcr = asRecord(enriched.ocr) ?? {};
      enriched.ocr = { ...existingTopOcr, textBlocks: result.ocr.textBlocks, sentenceInsights: result.ocr.sentenceInsights };

      return { product: enriched, performed: true, warnings, diagnostics };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(message);
      return {
        product,
        performed: false,
        warnings,
        diagnostics: { performed: false, targetCount: targets.length, excludedTargets, warnings },
      };
    }
  }
}

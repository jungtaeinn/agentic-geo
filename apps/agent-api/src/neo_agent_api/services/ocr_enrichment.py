"""OCR enrichment with copy-on-write data handling and request-time SSRF policy."""

from __future__ import annotations

import ipaddress
from collections.abc import Awaitable, Callable, Mapping, Sequence
from copy import deepcopy
from typing import Any
from urllib.parse import unquote, urlparse

import idna
from pdp_extractor_agent import extract_image_ocr_evidence

from neo_agent_api._json import as_dict, as_list

OcrExtractor = Callable[[Mapping[str, Any], Mapping[str, Any]], Awaitable[Mapping[str, Any]]]


def _record(value: object) -> dict[str, Any] | None:
    return as_dict(value) if isinstance(value, Mapping) else None


def _string_array(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    items = as_list(value)
    return [item for item in items if isinstance(item, str)] if all(isinstance(item, str) for item in items) else None


def _has_existing_ocr(product: object) -> bool:
    item = _record(product)
    if item is None:
        return False
    for scope in (item, _record(item.get("geoProduct")) or {}):
        source = _record(scope.get("sourceExtraction")) or {}
        for candidate in (source.get("ocr"), scope.get("ocr")):
            ocr = _record(candidate)
            if not ocr:
                continue
            if any(
                isinstance(ocr.get(key), list) and bool(ocr.get(key))
                for key in ("textBlocks", "imageTexts", "sentenceInsights")
            ):
                return True
    return False


def _collect_targets(product: object) -> tuple[list[str] | None, str | None, str | None]:
    record = _record(product)
    if record is None:
        return None, None, None
    for name, target in (
        ("ocrImages", record),
        ("geoProduct.ocrImages", _record(record.get("geoProduct")) or {}),
    ):
        if "ocrImages" not in target:
            continue
        values = _string_array(target.get("ocrImages"))
        if values is None:
            return None, name, None
        return values, None, name
    return None, None, None


def _whatwg_ipv4_hostname(hostname: str) -> str | None:
    """Return WHATWG's dotted-decimal spelling for a numeric IPv4 host.

    ``URL`` accepts one-to-four IPv4 components, hexadecimal components, and
    legacy octal components. ``ipaddress`` intentionally rejects those legacy
    spellings, so normalize them before applying the retained TypeScript
    private-network policy.
    """

    parts = hostname.rstrip(".").split(".")
    if not parts or len(parts) > 4 or any(part == "" for part in parts):
        return None
    numbers: list[int] = []
    for part in parts:
        base = 10
        digits = part
        if part.casefold().startswith("0x"):
            base, digits = 16, part[2:]
        elif len(part) > 1 and part.startswith("0"):
            base, digits = 8, part[1:]
        if not digits:
            return None
        try:
            number = int(digits, base)
        except ValueError:
            return None
        if number < 0:
            return None
        numbers.append(number)
    if any(number > 255 for number in numbers[:-1]):
        return None
    final_limit = 256 ** (5 - len(numbers))
    if numbers[-1] >= final_limit:
        return None
    address = numbers[-1]
    for index, number in enumerate(numbers[:-1]):
        address += number * (256 ** (3 - index))
    try:
        return str(ipaddress.IPv4Address(address))
    except ipaddress.AddressValueError:
        return None


def _normalize_whatwg_hostname(hostname: str) -> str:
    """Canonicalize a URL host using the WHATWG URL parser's UTS-46 boundary.

    Node first percent-decodes the host then applies UTS-46 domain mapping;
    U+3002/U+FF0E/U+FF61 all become a DNS dot before its legacy IPv4 parser
    sees the labels.  Python's ``urlparse`` intentionally leaves that work to
    callers, so do it here before applying the SSRF/allow-list policy.
    """

    decoded = unquote(hostname).strip().strip("[]").rstrip(".")
    try:
        remapped = idna.uts46_remap(decoded, std3_rules=False, transitional=False)
    except idna.IDNAError:
        remapped = decoded
    try:
        normalized = idna.encode(remapped, uts46=True, std3_rules=False, transitional=False).decode("ascii")
    except idna.IDNAError:
        # WHATWG permits several non-DNS host spellings (for example an
        # underscore). Retain the mapped spelling for policy checks instead of
        # treating that parser difference as a permitted bypass.
        normalized = remapped
    normalized = normalized.casefold().rstrip(".")
    return _whatwg_ipv4_hostname(normalized) or normalized


def _private_or_local_hostname(hostname: str) -> bool:
    normalized = _normalize_whatwg_hostname(hostname)
    if normalized == "localhost":
        return True
    normalized_ipv4 = _whatwg_ipv4_hostname(normalized)
    if normalized_ipv4 is not None:
        normalized = normalized_ipv4
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv4Address):
        first, second, *_ = address.packed
        return (
            first == 0
            or first == 127
            or first == 10
            or (first == 100 and 64 <= second <= 127)
            or (first == 172 and 16 <= second <= 31)
            or (first == 192 and second == 168)
            or (first == 169 and second == 254)
        )
    if address.ipv4_mapped is not None:
        return _private_or_local_hostname(str(address.ipv4_mapped))
    return (
        address == ipaddress.IPv6Address("::1")
        or address == ipaddress.IPv6Address("::")
        or address in ipaddress.ip_network("fc00::/7")
        or address in ipaddress.ip_network("fe80::/10")
    )


def _allowed_host(hostname: str, allowed_hosts: Sequence[str]) -> bool:
    host = _normalize_whatwg_hostname(hostname)
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in allowed_hosts)


def _read_name(product: object) -> str | None:
    record = _record(product) or {}
    for source in (record, _record(record.get("geoProduct")) or {}):
        value = source.get("name")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


class OcrEnrichmentService:
    def __init__(
        self,
        *,
        extract_image_ocr_evidence: OcrExtractor = extract_image_ocr_evidence,
        options: Mapping[str, Any] | None = None,
        allowed_hosts_raw: str | None = None,
    ) -> None:
        self._extract = extract_image_ocr_evidence
        self._options = as_dict(options)
        self._allowed_hosts_raw = allowed_hosts_raw

    async def enrich(self, product: object, source_url: str | None) -> dict[str, Any]:
        targets, contract_violation, target_path = _collect_targets(product)
        if contract_violation:
            warning = f"ocrImages contract violation: expected string[] ({contract_violation})"
            return self._outcome(
                product, False, "no-targets", [warning], 0, [{"url": contract_violation, "reason": "invalid-contract"}]
            )
        if not targets:
            return self._outcome(product, False, "no-targets", [], 0, [])
        if _has_existing_ocr(product):
            return self._outcome(product, False, "existing-ocr", [], len(targets), [])

        seen: set[str] = set()
        unique = [url for url in targets if not (url in seen or seen.add(url))]
        configured = self._allowed_hosts_raw is not None
        allowed_hosts = [
            _normalize_whatwg_hostname(entry) for entry in (self._allowed_hosts_raw or "").split(",") if entry.strip()
        ]
        misconfigured = configured and not allowed_hosts
        valid: list[str] = []
        excluded: list[dict[str, str]] = []
        policy_excluded = 0
        for url in unique:
            try:
                parsed = urlparse(url)
                hostname = _normalize_whatwg_hostname(parsed.hostname or "")
            except ValueError:
                parsed = None
                hostname = ""
            if parsed is None or not parsed.scheme or not parsed.netloc:
                excluded.append({"url": url, "reason": "invalid-url"})
                policy_excluded += 1
            elif parsed.scheme not in {"http", "https"}:
                excluded.append({"url": url, "reason": "unsupported-protocol"})
                policy_excluded += 1
            elif _private_or_local_hostname(hostname):
                excluded.append({"url": url, "reason": "private-or-local-address"})
                policy_excluded += 1
            elif misconfigured:
                excluded.append({"url": url, "reason": "allowlist-misconfigured"})
                policy_excluded += 1
            elif allowed_hosts and not _allowed_host(hostname, allowed_hosts):
                excluded.append({"url": url, "reason": "host-not-allowlisted"})
                policy_excluded += 1
            else:
                valid.append(url)
        overflow, valid = valid[50:], valid[:50]
        excluded.extend({"url": url, "reason": "target-limit-exceeded"} for url in overflow)
        warnings = [f"{policy_excluded} target(s) skipped by URL policy"] if policy_excluded else []
        if not valid:
            return self._outcome(product, False, None, warnings, len(targets), excluded)
        try:
            result = as_dict(
                await self._extract(
                    {
                        "source": source_url if source_url is not None else "agent-api:manual-json",
                        "productName": _read_name(product),
                        "imageUrls": valid,
                    },
                    self._options,
                )
            )
        except Exception as exc:
            warnings.append(str(exc))
            return self._outcome(product, False, None, warnings, len(targets), excluded)
        diagnostics_source = _record(result.get("diagnostics")) or {}
        source_warnings = as_list(diagnostics_source.get("warnings"))
        for item in source_warnings:
            warning = _record(item)
            message = warning.get("message") if warning is not None else str(item)
            if message:
                warnings.append(str(message))
        ocr = _record(result.get("ocr")) or {}
        performed = bool(ocr.get("imageTexts"))
        skipped_reason = (
            "provider-not-configured"
            if any(
                warning is not None and warning.get("code") == "IMAGE_OCR_PROVIDER_NOT_CONFIGURED"
                for item in source_warnings
                for warning in (_record(item),)
            )
            else None
        )
        diagnostics: dict[str, Any] = {
            "performed": performed,
            **({"skippedReason": skipped_reason} if skipped_reason else {}),
            "targetCount": len(targets),
            "excludedTargets": excluded,
            "ocr": diagnostics_source.get("ocr"),
            "runtimeUsage": diagnostics_source.get("runtimeUsage"),
            "warnings": warnings,
        }
        if not performed:
            return {
                "product": product,
                "performed": False,
                **({"skippedReason": skipped_reason} if skipped_reason else {}),
                "warnings": warnings,
                "diagnostics": diagnostics,
            }
        enriched = deepcopy(product)
        if not isinstance(enriched, dict):
            return {"product": product, "performed": False, "warnings": warnings, "diagnostics": diagnostics}
        enriched = as_dict(enriched)
        target = enriched
        if target_path == "geoProduct.ocrImages":
            target = _record(enriched.get("geoProduct")) or enriched
        source_extraction = _record(target.get("sourceExtraction")) or {}
        source_extraction["ocr"] = ocr
        target["sourceExtraction"] = source_extraction
        top_ocr = _record(target.get("ocr")) or {}
        top_ocr.update({"textBlocks": ocr.get("textBlocks"), "sentenceInsights": ocr.get("sentenceInsights")})
        target["ocr"] = top_ocr
        if target is not enriched:
            enriched["geoProduct"] = target
        return {"product": enriched, "performed": True, "warnings": warnings, "diagnostics": diagnostics}

    @staticmethod
    def _outcome(
        product: object,
        performed: bool,
        skipped_reason: str | None,
        warnings: list[str],
        target_count: int,
        excluded: list[dict[str, str]],
    ) -> dict[str, Any]:
        diagnostics: dict[str, Any] = {
            "performed": performed,
            **({"skippedReason": skipped_reason} if skipped_reason else {}),
            "targetCount": target_count,
            "excludedTargets": excluded,
            "warnings": warnings,
        }
        return {
            "product": product,
            "performed": performed,
            **({"skippedReason": skipped_reason} if skipped_reason else {}),
            "warnings": warnings,
            "diagnostics": diagnostics,
        }

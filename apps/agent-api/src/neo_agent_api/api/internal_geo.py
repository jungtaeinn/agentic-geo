"""Nest-compatible internal GEO routes and DTO boundary."""

from __future__ import annotations

import ipaddress
import re
import uuid
from collections.abc import Mapping
from typing import Any, Literal, cast

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response
from neo_js_compat import js_has_whitespace

from neo_agent_api._json import as_dict

from .console import console_json
from .dependencies import require_internal_api_key
from .errors import LegacyHttpError, legacy_validation_error

_DtoName = Literal["submit", "test"]
_UUID_PATTERN = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
    r"|00000000-0000-0000-0000-000000000000)$",
    re.IGNORECASE,
)
_URL_PROTOCOL = re.compile(r"^([a-z][a-z0-9+.-]*):", re.IGNORECASE)
_WRAPPED_IPV6 = re.compile(r"^\[([^\]]+)\](?::([0-9]+))?$")
_VALID_AUTH = re.compile(r"^[a-zA-Z0-9\-_.%:]*$")
_ENCODED_AUTH = re.compile(r"%[0-9a-fA-F]{2}")


def _is_uuid(value: object) -> bool:
    if not isinstance(value, str) or _UUID_PATTERN.fullmatch(value) is None:
        return False
    try:
        uuid.UUID(value)
    except ValueError, AttributeError:
        return False
    return True


def _is_http_url(value: object) -> bool:
    """Port validator.js ``isURL`` options used by ``@IsUrl`` exactly enough.

    The DTO opts into http(s), an explicit protocol, and validator.js's default
    required-TLD/FQDN/port checks.  ``urllib.parse`` only recognizes a URL
    shape, so it cannot stand in for the retained validator boundary.
    """

    if not isinstance(value, str):
        return False
    if not value or js_has_whitespace(value) or "<" in value or ">" in value or _utf16_length(value) > 2084:
        return False
    # validator.js discards fragment/query before parsing the authority.
    url = value.split("#", 1)[0].split("?", 1)[0]
    protocol_match = _URL_PROTOCOL.match(url)
    if protocol_match is None:
        return False
    potential_protocol = protocol_match.group(1)
    after_colon = url[protocol_match.end() :]
    starts_with_slashes = after_colon.startswith("//")
    if not starts_with_slashes:
        before_slash = after_colon.split("/", 1)[0]
        at_position = before_slash.find("@")
        if at_position != -1:
            before_at = before_slash[:at_position]
            # validator 13.15 distinguishes an auth-like colon from a scheme.
            # With this DTO's require_protocol=true it rejects the former.
            if _VALID_AUTH.fullmatch(before_at) is not None and _ENCODED_AUTH.search(before_at) is None:
                return False
        elif after_colon[:1].isdigit():
            # ``host:443`` is not an explicit protocol under validator.js.
            return False
    if potential_protocol.casefold() not in {"http", "https"}:
        return False
    authority_and_path = after_colon
    if authority_and_path.startswith("//"):
        # A matched explicit protocol always consumes normal ``//``.
        authority_and_path = authority_and_path[2:]
    if not authority_and_path:
        return False
    authority = authority_and_path.split("/", 1)[0]
    if not authority:
        return False
    auth_parts = authority.split("@")
    if len(auth_parts) > 1:
        auth = auth_parts.pop(0)
        if not auth or auth.count(":") > 1:
            return False
        user, _, password = auth.partition(":")
        if user == "" and password == "":
            return False
        authority = "@".join(auth_parts)

    wrapped = _WRAPPED_IPV6.fullmatch(authority)
    if wrapped is not None:
        host = ""
        ipv6 = wrapped.group(1)
        port_text = wrapped.group(2)
    else:
        parts = authority.split(":")
        host = parts.pop(0)
        ipv6 = None
        port_text = ":".join(parts) if parts else None
    if port_text:
        if not port_text.isascii() or not port_text.isdecimal():
            return False
        try:
            port = int(port_text)
        except ValueError:
            return False
        if port < 1 or port > 65535:
            return False

    return _is_ip_address(host) or _is_validator_fqdn(host) or (ipv6 is not None and _is_ipv6(ipv6))


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _is_ip_address(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _is_ipv6(value: str) -> bool:
    # validator.js 13.15.35 permits RFC-4007 zone identifiers only when their
    # characters match ``[0-9a-zA-Z.]``.  ``ipaddress`` accepts a broader
    # platform-style interface name (including ``eth-0``), so validate the
    # suffix before asking it about the address itself.
    address, marker, zone = value.partition("%")
    if marker and (not zone or re.fullmatch(r"[0-9A-Za-z.]+", zone) is None):
        return False
    try:
        return ipaddress.ip_address(address).version == 6
    except ValueError:
        return False


def _is_validator_fqdn(host: str) -> bool:
    parts = host.split(".")
    if len(parts) < 2:
        return False
    tld = parts[-1]
    if not _is_validator_tld(tld) or _is_ascii_decimal(tld) or js_has_whitespace(tld):
        return False
    for part in parts:
        if _utf16_length(part) > 63 or not _is_validator_fqdn_part(part):
            return False
        if re.search(r"[\uff01-\uff5e]", part) or part.startswith("-") or part.endswith("-") or "_" in part:
            return False
    return True


def _utf16_units(value: str) -> tuple[int, ...]:
    raw = value.encode("utf-16-le", "surrogatepass")
    return tuple(raw[index] | (raw[index + 1] << 8) for index in range(0, len(raw), 2))


def _is_ascii_decimal(value: str) -> bool:
    return bool(value) and all("0" <= character <= "9" for character in value)


def _is_validator_fqdn_part(value: str) -> bool:
    """Evaluate validator.js's UTF-16 regex against Python Unicode strings."""

    units = _utf16_units(value)
    if not units:
        return False
    for unit in units:
        if 48 <= unit <= 57 or unit in {45, 95}:
            continue
        if 65 <= unit <= 90 or 97 <= unit <= 122 or 0x00A1 <= unit <= 0xFFFF:
            continue
        return False
    return True


def _is_validator_tld(value: str) -> bool:
    units = _utf16_units(value)
    if len(units) >= 2 and all(
        65 <= unit <= 90
        or 97 <= unit <= 122
        or 0x00A1 <= unit <= 0x00A8
        or unit == 0x00AA
        or 0x00AA <= unit <= 0xD7FF
        or 0xF900 <= unit <= 0xFDCF
        or 0xFDF0 <= unit <= 0xFFEF
        for unit in units
    ):
        return True
    return (
        len(units) >= 4
        and units[0] in {ord("x"), ord("X")}
        and units[1] in {ord("n"), ord("N")}
        and all(65 <= unit <= 90 or 97 <= unit <= 122 or 48 <= unit <= 57 or unit == ord("-") for unit in units[2:])
    )


def _brand_messages(value: object) -> list[str]:
    """Keep class-validator's decorator/message order for ``brandSameAs``."""

    is_array = isinstance(value, list)
    values: list[object] = list(cast(list[object], value)) if is_array else [value]
    messages: list[str] = []
    if any(not _is_http_url(item) for item in values):
        messages.append("each value in brandSameAs must be a URL address")
    if not is_array or len(values) > 10:
        messages.append("brandSameAs must contain no more than 10 elements")
    if not is_array:
        messages.append("brandSameAs must be an array")
    return messages


def _dto_messages(record: Mapping[str, Any], kind: _DtoName) -> list[str]:
    messages: list[str] = []
    if kind == "submit" and not _is_uuid(record.get("geoGenerationId")):
        messages.append("geoGenerationId must be a UUID")

    locale = record.get("locale")
    # class-validator's IsNotEmpty is deliberately separate from IsString; a
    # numeric value only produces the latter message.
    if locale is None or locale == "":
        messages.append("locale should not be empty")
    if not isinstance(locale, str):
        messages.append("locale must be a string")

    if not isinstance(record.get("product"), Mapping):
        messages.append("product must be an object")

    if kind == "test" and "includeDiagnostics" in record and record["includeDiagnostics"] is not None:
        if not isinstance(record["includeDiagnostics"], bool):
            messages.append("includeDiagnostics must be a boolean value")

    if "brandSameAs" in record and record["brandSameAs"] is not None:
        messages.extend(_brand_messages(record["brandSameAs"]))
    return messages


async def _dto(request: Request, kind: _DtoName) -> tuple[dict[str, Any] | None, list[str]]:
    # ``InternalJsonParserMiddleware`` only parses JSON media types, matching
    # Express' json parser. Text/plain payloads therefore reach validation as
    # an absent body rather than being accepted by Starlette's Request.json.
    record = as_dict(getattr(request.state, "neo_internal_json", None))
    messages = _dto_messages(record, kind)
    if messages:
        return None, messages
    allowed = (
        ("geoGenerationId", "locale", "product", "brandSameAs")
        if kind == "submit"
        else ("locale", "product", "includeDiagnostics", "brandSameAs")
    )
    return {key: record[key] for key in allowed if key in record}, []


router = APIRouter()


@router.get("/health")
async def health() -> Response:
    return console_json({"status": "ok"})


@router.post(
    "/internal/v1/geo/generations",
    status_code=202,
    dependencies=[Depends(require_internal_api_key)],
    response_model=None,
)
async def submit_generation(request: Request) -> Response:
    dto, messages = await _dto(request, "submit")
    if dto is None:
        return legacy_validation_error(messages)
    await request.app.state.acceptance.accept(dto)
    return console_json({"accepted": True, "geoGenerationId": dto["geoGenerationId"]}, 202)


@router.post("/internal/v1/geo/test-generations", dependencies=[Depends(require_internal_api_key)], response_model=None)
async def test_generation(request: Request) -> Response:
    # Nest validates body DTOs before entering the controller, so this remains
    # before the feature flag.
    dto, messages = await _dto(request, "test")
    if dto is None:
        return legacy_validation_error(messages)
    if not request.app.state.settings.geo_test_sync_endpoint:
        raise LegacyHttpError(404, "Not Found", "Not Found")
    generation_id = str(uuid.uuid4())
    artifact_record: dict[str, Any] = {}

    async def generate_response() -> dict[str, Any]:
        nonlocal artifact_record
        artifact = await request.app.state.generation_service.generate({"geoGenerationId": generation_id, **dto})
        artifact_record = as_dict(artifact)
        diagnostics = as_dict(artifact_record.get("diagnostics"))
        response: dict[str, Any] = {
            "geoGenerationId": generation_id,
            "resultStatus": artifact_record.get("resultStatus"),
            "jsonLd": artifact_record.get("jsonLd"),
            "scriptTag": artifact_record.get("scriptTag"),
            "schemaTypes": artifact_record.get("schemaTypes"),
            "resultHash": artifact_record.get("resultHash"),
            "ragProfile": artifact_record.get("ragProfile"),
            "generatedAt": artifact_record.get("generatedAt"),
            "validationWarnings": diagnostics.get("validationWarnings") or [],
        }
        runtime_usage = diagnostics.get("runtimeUsage")
        if runtime_usage is not None:
            response["runtimeUsage"] = runtime_usage
        return {key: value for key, value in response.items() if value is not None}

    try:
        response = await request.app.state.tracer.run_sync_generation(
            generate_response,
            geo_generation_id=generation_id,
            input_payload={"locale": dto["locale"], "product": dto["product"]},
            runtime_usage=lambda: as_dict(artifact_record.get("diagnostics")).get("runtimeUsage"),
        )
    finally:
        await request.app.state.tracer.flush()
    if dto.get("includeDiagnostics"):
        response["diagnostics"] = as_dict(artifact_record.get("diagnostics"))
        response["contentSections"] = artifact_record.get("contentSections")
    return console_json(response)

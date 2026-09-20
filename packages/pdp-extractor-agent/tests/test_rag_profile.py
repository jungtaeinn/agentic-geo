"""Ports of extractor RAG profile and retrieval contracts (3 cases)."""

from __future__ import annotations

import ast
import json
import os
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Protocol, cast

import httpx
import pytest

from pdp_extractor_agent.rag.default_profile import default_profile
from pdp_extractor_agent.rag.profile_store import (
    read_product_extractor_rag_profile,
    read_profile,
    reset_profile,
    write_product_extractor_rag_profile,
    write_profile,
)
from pdp_extractor_agent.rag.retrieval import (
    create_product_extractor_rag_query,
    retrieve_product_extractor_rag_documents,
    retrieve_product_extractor_rag_documents_with_runtime,
)

_FROZEN_RAG_WRITER_CONTRACT = Path(__file__).with_name("fixtures") / "rag-profile-write-contract.v1.json"
_FROZEN_RAG_WRITER_CONTRACT_SHA256 = "25f29554a713cd0122ebf80f0321d3901e2c3512e6c6f0981a308604949460c8"

type JsonScalar = None | bool | int | float | str
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]
type JsonObject = dict[str, JsonValue]

_RAG_WIRE_EDGE_BYTES = b'{"input":["x\\ud800","\xed\x95\x9c\xf0\x9f\x98\x80"]}'


def _canonical_json_digest(value: JsonValue) -> str:
    """Hash a type-exact JSON form; the original number spelling is evidence."""

    try:
        canonical = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except ValueError as caught:
        raise AssertionError("frozen contract cannot contain a non-JSON number") from caught
    return sha256(canonical.encode("utf-8")).hexdigest()


@pytest.mark.asyncio
async def test_remote_rag_post_uses_javascript_json_bytes_for_edge_values() -> None:
    """The public Azure embedding wire preserves JSON.stringify's UTF-16 behavior."""

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["content-type"] == "application/json"
        assert request.content == _RAG_WIRE_EDGE_BYTES
        return httpx.Response(
            200,
            json={"data": [{"index": 0, "embedding": [1.0]}, {"index": 1, "embedding": [1.0]}]},
        )

    result = await retrieve_product_extractor_rag_documents_with_runtime(
        {
            "query": "x\ud800",
            "documents": [{"name": "wire.md", "content": "한😀"}],
            "settings": {"maxChunks": 1, "scoreThreshold": 0},
            "embedding": {
                "provider": "azure-openai",
                "apiKey": "key",
                "endpoint": "https://rag.example",
                "deployment": "embed",
                "transport": httpx.MockTransport(handler),
            },
        }
    )

    assert len(result) == 1


def _json_value(value: object) -> JsonValue:
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, list):
        return [_json_value(item) for item in cast(list[object], value)]
    if isinstance(value, dict):
        result: JsonObject = {}
        for key, item in cast(dict[object, object], value).items():
            if not isinstance(key, str):
                raise AssertionError("frozen contract object keys must be strings")
            result[key] = _json_value(item)
        return result
    raise AssertionError(f"frozen contract contains non-JSON value: {type(value)!r}")


def _json_object(value: object) -> JsonObject:
    parsed = _json_value(value)
    if not isinstance(parsed, dict):
        raise AssertionError("frozen contract object expected")
    return parsed


def _mutable_json_object(value: JsonValue) -> JsonObject:
    if not isinstance(value, dict):
        raise AssertionError("frozen contract object expected")
    return value


class _FrozenContractBytesReader(Protocol):
    def read_bytes(self) -> bytes: ...


def _assert_frozen_contract_raw_sha256(raw_fixture: bytes) -> None:
    actual = sha256(raw_fixture).hexdigest()
    assert actual == _FROZEN_RAG_WRITER_CONTRACT_SHA256, (
        "frozen RAG writer contract raw SHA-256 changed; recapture and independently approve the complete legacy contract"
    )


def _assert_case_digests_are_self_consistent(contract: JsonObject) -> None:
    cases_value = contract.get("cases")
    if not isinstance(cases_value, list):
        raise AssertionError("frozen contract requires cases")
    for case_value in cases_value:
        case = _json_object(case_value)
        profile = _json_object(case["input"])
        expected = _json_object(case["expected"])
        assert _canonical_json_digest(profile) == case["inputSha256"]
        assert _canonical_json_digest(expected) == case["expectedSha256"]


def _load_frozen_rag_writer_contract(
    fixture: _FrozenContractBytesReader = _FROZEN_RAG_WRITER_CONTRACT,
) -> tuple[JsonObject, list[JsonObject]]:
    raw_fixture = fixture.read_bytes()
    _assert_frozen_contract_raw_sha256(raw_fixture)
    raw: object = json.loads(raw_fixture.decode("utf-8"))
    contract = _json_object(raw)
    cases_value = contract.get("cases")
    if not isinstance(cases_value, list):
        raise AssertionError("frozen contract requires cases")
    cases: list[JsonObject] = []
    for case in cases_value:
        cases.append(_json_object(case))
    return contract, cases


def _attribute_name(expression: ast.expr) -> str | None:
    if isinstance(expression, ast.Name):
        return expression.id
    if isinstance(expression, ast.Attribute):
        prefix = _attribute_name(expression.value)
        return f"{prefix}.{expression.attr}" if prefix is not None else None
    return None


def _assert_python_test_sources_do_not_execute_legacy_typescript(test_root: Path) -> None:
    forbidden_imports = {"subprocess"}
    forbidden_calls = {
        "asyncio.create_subprocess_exec",
        "asyncio.create_subprocess_shell",
        "os.popen",
        "os.system",
        "subprocess.call",
        "subprocess.check_call",
        "subprocess.check_output",
        "subprocess.Popen",
        "subprocess.run",
    }
    forbidden_executables = {"node", "tsx"}
    violations: list[str] = []

    for source in test_root.rglob("*.py"):
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                if any(alias.name.split(".")[0] in forbidden_imports for alias in node.names):
                    violations.append(f"{source}: imports subprocess")
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                if node.module.split(".")[0] in forbidden_imports:
                    violations.append(f"{source}: imports subprocess")
            elif isinstance(node, ast.Call):
                call_name = _attribute_name(node.func)
                if call_name in forbidden_calls:
                    violations.append(f"{source}: calls {call_name}")
                if any(
                    isinstance(argument, ast.Constant)
                    and isinstance(argument.value, str)
                    and argument.value in forbidden_executables
                    for argument in node.args
                ):
                    violations.append(f"{source}: looks up or invokes a legacy TypeScript executable")

    assert not violations, "\n".join(violations)


def test_frozen_rag_writer_contract_pins_legacy_inputs_expected_outputs_and_provenance() -> None:
    contract, cases = _load_frozen_rag_writer_contract()

    assert contract["schemaVersion"] == 1
    provenance = _json_object(contract["provenance"])
    assert provenance["legacySourcePath"] == "src/rag/profile.ts"
    assert provenance["legacySourceBlob"] == "35a3a1faac89ab8dce015a55219dae3c11a846a0"
    assert provenance["legacySourceLastChange"] == "6689224ca088f6cfd2a9d673e8c268685d73719a"
    assert provenance["nodeVersion"] == "v24.11.0"
    assert provenance["pnpmVersion"] == "11.24.0"
    assert provenance["tsxVersion"] == "4.23.1"
    assert provenance["defaultLocale"] == "en-US"
    assert provenance["legacySourceSha256"] == "a4155b9a4b4734fd7a4c3606cca73c66805018d6dfbc54ba4cafd9ba69e469bb"
    assert provenance["icuVersion"] == "77.1"
    assert _json_object(provenance["collator"]) == {
        "locale": "en-US",
        "usage": "sort",
        "sensitivity": "variant",
        "ignorePunctuation": False,
        "collation": "default",
        "numeric": False,
        "caseFirst": "false",
    }
    assert cases

    for case in cases:
        profile = _json_object(case["input"])
        expected = _json_object(case["expected"])
        assert _canonical_json_digest(profile) == case["inputSha256"]
        assert _canonical_json_digest(expected) == case["expectedSha256"]


def _frozen_contract_mutation() -> JsonObject:
    return _json_object(json.loads(_FROZEN_RAG_WRITER_CONTRACT.read_text(encoding="utf-8")))


def _frozen_contract_cases(contract: JsonObject) -> list[JsonObject]:
    cases_value = contract["cases"]
    assert isinstance(cases_value, list)
    return [_mutable_json_object(case) for case in cases_value]


def _reject_mutated_frozen_contract(contract: JsonObject, tmp_path: Path) -> None:
    _assert_case_digests_are_self_consistent(contract)
    mutated_fixture = tmp_path / "mutated-rag-profile-write-contract.v1.json"
    mutated_fixture.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="raw SHA-256"):
        _load_frozen_rag_writer_contract(mutated_fixture)


def test_frozen_rag_writer_contract_pins_exact_raw_fixture_bytes() -> None:
    assert sha256(_FROZEN_RAG_WRITER_CONTRACT.read_bytes()).hexdigest() == _FROZEN_RAG_WRITER_CONTRACT_SHA256


class _SplitReadFixture:
    """Models a fixture changing after a pinned first read."""

    def __init__(self, pinned_bytes: bytes, altered_bytes: bytes) -> None:
        self._pinned_bytes = pinned_bytes
        self._altered_bytes = altered_bytes
        self.byte_read_count = 0
        self.text_read_count = 0

    def read_bytes(self) -> bytes:
        self.byte_read_count += 1
        return self._pinned_bytes if self.byte_read_count == 1 else self._altered_bytes

    def read_text(self, *, encoding: str) -> str:
        self.text_read_count += 1
        return self._altered_bytes.decode(encoding)


def test_frozen_rag_writer_contract_parses_the_same_bytes_it_hashes() -> None:
    altered_contract = _frozen_contract_mutation()
    altered_cases = altered_contract["cases"]
    assert isinstance(altered_cases, list)
    altered_cases.pop()
    fixture = _SplitReadFixture(
        _FROZEN_RAG_WRITER_CONTRACT.read_bytes(),
        json.dumps(altered_contract, ensure_ascii=False).encode("utf-8"),
    )

    _, cases = _load_frozen_rag_writer_contract(fixture)

    assert len(cases) == 35
    assert fixture.byte_read_count == 1
    assert fixture.text_read_count == 0


def test_frozen_rag_writer_contract_rejects_case_deletion_even_when_remaining_case_hashes_match(tmp_path: Path) -> None:
    contract = _frozen_contract_mutation()
    cases_value = contract["cases"]
    assert isinstance(cases_value, list)
    cases_value.pop()

    _reject_mutated_frozen_contract(contract, tmp_path)


def test_frozen_rag_writer_contract_rejects_same_count_case_substitution_with_coordinated_hashes(tmp_path: Path) -> None:
    contract = _frozen_contract_mutation()
    target, replacement, *_ = _frozen_contract_cases(contract)
    target["input"] = replacement["input"]
    target["expected"] = replacement["expected"]
    target["inputSha256"] = _canonical_json_digest(_json_object(target["input"]))
    target["expectedSha256"] = _canonical_json_digest(_json_object(target["expected"]))

    _reject_mutated_frozen_contract(contract, tmp_path)


def test_frozen_rag_writer_contract_rejects_coordinated_negative_zero_input_and_outcome_edit(tmp_path: Path) -> None:
    contract = _frozen_contract_mutation()
    negative_zero_case = next(case for case in _frozen_contract_cases(contract) if case["id"] == "malformed-negative-zero-name")
    profile = _mutable_json_object(negative_zero_case["input"])
    documents_value = profile["documents"]
    assert isinstance(documents_value, list)
    document = _mutable_json_object(documents_value[0])
    document["name"] = 0
    expected = _mutable_json_object(negative_zero_case["expected"])
    error = _mutable_json_object(expected["error"])
    error["message"] = 'The "path" argument must be of type string. Received type number (0)'
    negative_zero_case["inputSha256"] = _canonical_json_digest(profile)
    negative_zero_case["expectedSha256"] = _canonical_json_digest(expected)

    _reject_mutated_frozen_contract(contract, tmp_path)


def test_type_exact_contract_digest_preserves_boolean_and_number_distinctions() -> None:
    assert _canonical_json_digest(-0.0) != _canonical_json_digest(0)
    assert _canonical_json_digest(True) != _canonical_json_digest(1)
    assert _canonical_json_digest(1) != _canonical_json_digest(1.0)


def test_python_test_sources_keep_legacy_provenance_read_only() -> None:
    _assert_python_test_sources_do_not_execute_legacy_typescript(Path(__file__).parent)


def test_runtime_analysis_prompt_and_documents_are_retrievable_as_policy_chunks(tmp_path: Path) -> None:
    profile = read_profile(state_dir=tmp_path)
    profile["analysisPrompt"] = "Runtime typed RAG policy."
    profile["documents"].append(
        {"name": "runtime.md", "version": "v1", "content": "Runtime barrier hydration downstream audit policy."}
    )
    write_profile(profile, state_dir=tmp_path)
    query = create_product_extractor_rag_query({"productName": "Barrier Cream", "benefits": ["barrier hydration"]})
    docs = retrieve_product_extractor_rag_documents(query, state_dir=tmp_path)
    assert any(item["kind"] == "analysisPrompt" and "typed RAG" in item["text"] for item in docs)
    assert any(item["name"] == "runtime.md" and "downstream audit" in item["text"] for item in docs)


def test_reads_writes_and_resets_package_managed_profile_files(tmp_path: Path) -> None:
    initial = read_profile(state_dir=tmp_path)
    changed = {
        **initial,
        "analysisPrompt": "Changed policy",
        "documents": [{"name": "custom.md", "version": "v1", "content": "custom"}],
    }
    assert write_profile(changed, state_dir=tmp_path)["analysisPrompt"] == "Changed policy"
    assert read_profile(state_dir=tmp_path)["documents"][0]["name"] == "custom.md"
    reset = reset_profile(state_dir=tmp_path)
    assert reset["profile"] == "pdp-extractor-default"
    assert reset["analysisPrompt"] != "Changed policy"


@pytest.mark.asyncio
async def test_retrieval_prefers_policy_chunks_that_match_product_evidence() -> None:
    query = create_product_extractor_rag_query(
        {
            "source": "https://example.com/product",
            "productName": "Hydra Barrier Cream",
            "imageTexts": [
                {"imageUrl": "https://example.com/product#section-1", "text": "[How to Use] Apply morning and night after toner."},
                {
                    "imageUrl": "https://example.com/product#section-2",
                    "text": "[Coupon] Delivery and exchange notices are not product benefits.",
                },
            ],
        }
    )
    docs = await retrieve_product_extractor_rag_documents_with_runtime(
        {
            "query": query,
            "documents": [
                {
                    "name": "ocr-policy.md",
                    "content": (
                        "# OCR Policy\n\nClassify usage instructions, benefits, ingredients, and sentence-level OCR evidence.\n"
                        "Exclude cart, coupon, delivery, exchange, refund, legal, and page chrome text from product benefit fields."
                    ),
                },
                {"name": "unrelated.md", "content": "# Brand Voice\n\nUse short copy."},
            ],
            "settings": {"maxChunks": 1, "scoreThreshold": 0},
        }
    )
    assert len(docs) == 1
    assert docs[0]["sourceDocument"] == "ocr-policy.md"
    assert "Retrieved RAG policy chunk" in docs[0]["content"]
    assert docs[0]["kind"] == "ocr-classification"
    assert {"classification", "exclusion"}.issubset(docs[0]["intents"])
    assert {"ocr.sentenceInsights", "diagnostics"}.issubset(docs[0]["fieldTargets"])
    assert "Exclude cart, coupon, delivery" in docs[0]["content"]


@pytest.mark.asyncio
async def test_remote_rag_follows_redirects_records_runtime_and_omits_undefined_cohere_model() -> None:
    """Remote embedding/rerank use fetch-like redirects and JSON.stringify omission semantics."""

    urls: list[str] = []
    rerank_payloads: list[dict[str, object]] = []
    steps: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        urls.append(str(request.url))
        if request.url.path.endswith("/embeddings"):
            return httpx.Response(307, headers={"Location": "https://azure.example/redirected-embeddings"})
        if request.url.path == "/redirected-embeddings":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"index": 0, "embedding": [1.0, 0.0]},
                        {"index": 1, "embedding": [0.0, 1.0]},
                        {"index": 2, "embedding": [0.5, 0.5]},
                    ],
                    "usage": {"prompt_tokens": 3, "total_tokens": 3},
                },
            )
        if request.url.path == "/v2/rerank":
            rerank_payloads.append(json.loads(request.content))
            return httpx.Response(307, headers={"Location": "https://rerank.example/redirected-rerank"})
        if request.url.path == "/redirected-rerank":
            return httpx.Response(200, json={"results": [{"index": 1, "relevance_score": 0.99}, {"index": 0}]})
        raise AssertionError(f"unexpected request {request.url}")

    transport = httpx.MockTransport(handler)
    result = await retrieve_product_extractor_rag_documents_with_runtime(
        {
            "query": "barrier",
            "documents": [
                {"name": "first.md", "content": "barrier policy evidence"},
                {"name": "second.md", "content": "barrier classification evidence"},
            ],
            "settings": {"maxChunks": 2, "scoreThreshold": 0},
            "embedding": {
                "provider": "azure-openai",
                "apiKey": "key",
                "endpoint": "https://azure.example",
                "deployment": "embed",
                "transport": transport,
            },
            "reranker": {
                "provider": "cohere",
                "apiKey": "key",
                "endpoint": "https://rerank.example",
                "transport": transport,
            },
            "onRuntimeStep": steps.append,
        }
    )

    # The remote score explicitly promotes index 1.  The local ranker puts
    # ``second.md`` first, so this proves the redirected reranker response
    # was actually applied rather than silently falling back to local order.
    assert result[0]["sourceDocument"] == "first.md"
    assert any(url.endswith("/redirected-embeddings") for url in urls)
    assert any(url.endswith("/redirected-rerank") for url in urls)
    assert "model" not in rerank_payloads[0]
    assert [step["stage"] for step in steps] == ["embedding", "reranking"]


def test_public_profile_write_accepts_patch_dto_and_returns_managed_plus_custom_documents(tmp_path: Path) -> None:
    stored = write_product_extractor_rag_profile(
        {"analysisPrompt": "", "documents": [{"name": "custom.md", "content": "custom"}]}, state_dir=tmp_path
    )

    managed_names = [document["name"] for document in default_profile()["documents"]]
    assert stored["profile"] == "pdp-extractor-default"
    assert stored["analysisPrompt"] == f"{default_profile()['analysisPrompt']}\n"
    assert [document["name"] for document in stored["documents"]] == [*managed_names, "custom_v1.md"]
    assert [document["managed"] for document in stored["documents"]] == [True, True, True, True, False]
    assert {key: value for key, value in stored["documents"][-1].items() if key != "updatedAt"} == {
        "name": "custom_v1.md",
        "version": "v1",
        "content": "custom\n",
        "managed": False,
        "path": "custom/custom_v1.md",
        "size": 7,
    }
    assert stored["documents"][-1]["updatedAt"].endswith("Z")
    assert all(document["content"].endswith("\n") for document in stored["documents"])

    overridden = write_product_extractor_rag_profile(
        {
            "analysisPrompt": "Operator policy",
            "documents": [{"name": "faq-extraction_v1.md", "content": "override"}],
        },
        state_dir=tmp_path,
    )
    assert overridden["analysisPrompt"] == "Operator policy\n"
    assert overridden["documents"][-1]["name"] == "faq-extraction_v1.md"
    assert overridden["documents"][-1]["content"] == "override\n"
    assert all(document["managed"] for document in overridden["documents"])


def _legacy_public_profile_files(state_dir: Path) -> list[str]:
    """Exclude the Python-only retrieval snapshot from the legacy asset observation."""

    return sorted(
        relative.as_posix()
        for path in state_dir.rglob("*")
        if path.is_file()
        if (relative := path.relative_to(state_dir)).as_posix() != "pdp-extractor-rag-profile.json"
    )


def _python_writer_observation(profile: JsonObject, state_dir: Path) -> JsonObject:
    """Observe exactly the legacy public outcome shape without consulting TypeScript."""

    try:
        stored = write_product_extractor_rag_profile(profile, state_dir=state_dir)
    except TypeError as caught:
        return _json_object(
            {
                "error": {"name": type(caught).__name__, "message": str(caught)},
                "files": _legacy_public_profile_files(state_dir),
            }
        )

    documents_value: object = stored.get("documents")
    if not isinstance(documents_value, list):
        raise AssertionError("public writer must return documents")
    documents = cast(list[object], documents_value)
    custom_documents: list[JsonObject] = []
    for document in documents:
        public_document = _json_object(document)
        if public_document.get("managed") is False:
            custom_documents.append({key: value for key, value in public_document.items() if key != "updatedAt"})
    return _json_object(
        {
            "error": None,
            "files": _legacy_public_profile_files(state_dir),
            "documents": custom_documents,
        }
    )


def test_public_profile_writer_matches_frozen_legacy_contract(tmp_path: Path) -> None:
    """The Python writer is checked directly against the captured Node outcomes."""

    _, cases = _load_frozen_rag_writer_contract()
    for case in cases:
        case_id = case.get("id")
        if not isinstance(case_id, str):
            raise AssertionError("frozen contract case requires an id")
        profile = _json_object(case["input"])
        expected = _json_object(case["expected"])

        assert _python_writer_observation(profile, tmp_path / case_id) == expected, case_id
def test_public_profile_read_includes_each_document_mtime_and_aggregate_updated_at(tmp_path: Path) -> None:
    """Storage metadata is public UI state, not an optional implementation detail."""

    write_product_extractor_rag_profile(
        {"analysisPrompt": "Operator policy", "documents": [{"name": "custom.md", "content": "custom"}]},
        state_dir=tmp_path,
    )
    stored = read_product_extractor_rag_profile(state_dir=tmp_path)
    document_updates = [document["updatedAt"] for document in stored["documents"]]

    assert all(isinstance(value, str) and value.endswith("Z") for value in document_updates)
    assert stored["updatedAt"] == max(document_updates)


def test_public_profile_reads_each_managed_and_custom_asset_mtime_from_disk(tmp_path: Path) -> None:
    """The public DTO exposes file metadata, never one synthetic profile timestamp."""

    written = write_product_extractor_rag_profile(
        {"analysisPrompt": "Operator policy", "documents": [{"name": "custom.md", "content": "custom"}]},
        state_dir=tmp_path,
    )
    paths = [tmp_path / document["path"] for document in written["documents"]]
    assert all(path.exists() for path in paths)

    expected: dict[str, str] = {}
    for index, (document, path) in enumerate(zip(written["documents"], paths, strict=True), start=1):
        timestamp = 1_700_000_000 + index
        os.utime(path, (timestamp, timestamp))
        expected[document["path"]] = datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )

    stored = read_product_extractor_rag_profile(state_dir=tmp_path)
    assert {document["path"]: document["updatedAt"] for document in stored["documents"]} == expected
    assert stored["updatedAt"] == max(expected.values())

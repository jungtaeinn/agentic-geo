"""FastAPI application assembly, HTTP middleware, and service lifecycle."""

from __future__ import annotations

import ctypes
import inspect
import logging
import zlib
from collections.abc import Awaitable, Mapping
from contextlib import asynccontextmanager
from importlib import import_module
from typing import Any, Protocol, cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pdp_extractor_agent import (
    read_product_extractor_rag_profile,
    reset_product_extractor_rag_profile,
    write_product_extractor_rag_profile,
)
from pdp_geo_generator_agent import (
    read_pdp_geo_generator_rag_profile,
    reset_pdp_geo_generator_rag_profile,
    write_pdp_geo_generator_rag_profile,
)
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ._json import as_dict
from .api.console import console_json
from .api.console import router as console_router
from .api.dependencies import request_id_context
from .api.errors import (
    LegacyHttpError,
    legacy_error,
    legacy_http_exception_handler,
    legacy_request_validation_handler,
    legacy_validation_error,
)
from .api.internal_geo import router as internal_router
from .api.json_request import (
    JsonRequestParseError,
    UnsupportedJsonCharset,
    content_type_parts,
    is_express_json_media_type,
    parse_express_json_body,
)
from .api.rag_profiles import router as rag_profile_router
from .observability.logging import configure_logging, log_event
from .observability.tracing import create_tracer
from .persistence.database import Database, create_database
from .persistence.geo_generation_repository import GeoGenerationRepository
from .persistence.geo_result_repository import GeoResultRepository
from .services.acceptance import GeoAcceptanceService
from .services.generation import GenerationService, GeoProcessor
from .services.ocr_enrichment import OcrEnrichmentService
from .services.queue import GeoQueue
from .settings import Settings

_MAX_BODY_BYTES = 2 * 1024 * 1024
_QUEUE_MAX_ATTEMPTS = 2
_QUEUE_BACKOFF_MS = 5000
_COMPRESSED_INPUT_CHUNK_BYTES = 64 * 1024

# Public narrow seam for the retained parser-limit contract.
MAX_BODY_BYTES = _MAX_BODY_BYTES


class _BrotliNativeModule(Protocol):
    __file__: str


class _BrotliModule(Protocol):
    _brotli: _BrotliNativeModule


class _CompressionReadError(OSError):
    """A body-parser contentstream failure with Node's public message."""


class _BodyTooLarge(ValueError):
    """The decoded raw-body stream crossed body-parser's two-MiB limit."""


class _IdentityBodyDecoder:
    def feed(self, data: bytes, limit: int) -> bytes:
        return data[:limit]

    def finish(self, _limit: int) -> bytes:
        return b""

    def close(self) -> None:
        return None


def _zlib_error_message(error: BaseException) -> str:
    """Strip CPython's zlib prefix to retain Node's error text."""

    message = str(error)
    if message.startswith("Error ") and ": " in message:
        return message.rsplit(": ", 1)[1]
    return message or "unexpected end of file"


class _ZlibBodyDecoder:
    def __init__(self, wbits: int) -> None:
        self._wbits = wbits
        self._decoder = zlib.decompressobj(wbits)
        # Node's createGunzip consumes concatenated gzip members and permits
        # terminal NUL padding. createInflate stops after its first stream.
        self._concatenate_members = wbits == 16 + zlib.MAX_WBITS
        self._discard_after_member = False

    def feed(self, data: bytes, limit: int) -> bytes:
        output = bytearray()
        try:
            # ASGI frames are not bounded. Giving a whole compressed frame
            # to ``decompress`` may materialize a matching-size
            # ``unconsumed_tail`` when the decoded limit is reached.
            for start in range(0, len(data), _COMPRESSED_INPUT_CHUNK_BYTES):
                pending = data[start : start + _COMPRESSED_INPUT_CHUNK_BYTES]
                while pending and len(output) < limit:
                    if self._decoder.eof:
                        pending = self._after_completed_member(pending)
                        if not pending:
                            break
                    output.extend(self._decoder.decompress(pending, limit - len(output)))
                    if self._decoder.unconsumed_tail:
                        pending = self._decoder.unconsumed_tail
                        continue
                    if self._decoder.eof and self._decoder.unused_data:
                        pending = self._decoder.unused_data
                        continue
                    pending = b""
                if len(output) >= limit:
                    break
        except zlib.error as exc:
            raise _CompressionReadError(_zlib_error_message(exc)) from exc
        return bytes(output)

    def finish(self, limit: int) -> bytes:
        if self._decoder.eof or self._discard_after_member:
            return b""
        try:
            output = self._decoder.flush(limit)
        except zlib.error as exc:
            raise _CompressionReadError(_zlib_error_message(exc)) from exc
        if not self._decoder.eof:
            raise _CompressionReadError("unexpected end of file")
        return output

    def _after_completed_member(self, pending: bytes) -> bytes:
        if self._discard_after_member:
            return b""
        if not self._concatenate_members:
            self._discard_after_member = True
            return b""
        # createGunzip treats the first NUL after a completed member as
        # terminal padding. It remains terminal when later frames carry data;
        # do not feed that data into a fresh zlib member.
        if pending.startswith(b"\0"):
            self._discard_after_member = True
            return b""
        self._decoder = zlib.decompressobj(self._wbits)
        return pending

    def close(self) -> None:
        return None

    @property
    def unconsumed_tail_size(self) -> int:
        """Expose only the bounded decoder-tail invariant used by parser regressions."""

        return len(self._decoder.unconsumed_tail)


# Public narrow seam for byte-level decoder regressions.
ZlibBodyDecoder = _ZlibBodyDecoder


_BROTLI_MODULE: _BrotliNativeModule | None = getattr(cast(_BrotliModule, import_module("brotli")), "_brotli", None)
if _BROTLI_MODULE is None:  # pragma: no cover - the locked runtime supplies it.
    raise RuntimeError("brotli native decoder is unavailable")
_BROTLI_LIBRARY = ctypes.CDLL(str(getattr(_BROTLI_MODULE, "__file__")))
_BROTLI_U8 = ctypes.c_uint8
_BROTLI_U8_POINTER = ctypes.POINTER(_BROTLI_U8)
_BROTLI_LIBRARY.BrotliDecoderCreateInstance.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
_BROTLI_LIBRARY.BrotliDecoderCreateInstance.restype = ctypes.c_void_p
_BROTLI_LIBRARY.BrotliDecoderDestroyInstance.argtypes = [ctypes.c_void_p]
_BROTLI_LIBRARY.BrotliDecoderDecompressStream.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_size_t),
    ctypes.POINTER(_BROTLI_U8_POINTER),
    ctypes.POINTER(ctypes.c_size_t),
    ctypes.POINTER(_BROTLI_U8_POINTER),
    ctypes.POINTER(ctypes.c_size_t),
]
_BROTLI_LIBRARY.BrotliDecoderDecompressStream.restype = ctypes.c_int
_BROTLI_OUTPUT_CHUNK_BYTES = 64 * 1024
_BROTLI_ERROR = 0
_BROTLI_SUCCESS = 1
_BROTLI_NEEDS_MORE_INPUT = 2
_BROTLI_NEEDS_MORE_OUTPUT = 3


class _BrotliBodyDecoder:
    """Bound Brotli output with the extension's streaming C decoder API."""

    def __init__(self) -> None:
        state = _BROTLI_LIBRARY.BrotliDecoderCreateInstance(None, None, None)
        if not state:
            raise _CompressionReadError("Decompression failed")
        self._state: int | None = state
        self._finished = False

    def feed(self, data: bytes, limit: int) -> bytes:
        if self._finished:
            return b""
        output = bytearray()
        # ASGI servers are permitted to yield an arbitrarily large body
        # frame.  ``from_buffer_copy`` must therefore never mirror the whole
        # compressed frame in native memory; the C decoder keeps its own
        # incremental state across these fixed-size inputs.
        for start in range(0, len(data), _COMPRESSED_INPUT_CHUNK_BYTES):
            if len(output) >= limit or self._finished:
                break
            chunk = data[start : start + _COMPRESSED_INPUT_CHUNK_BYTES]
            output.extend(self._decode(chunk, limit - len(output), final=False))
        return bytes(output)

    def finish(self, limit: int) -> bytes:
        if self._finished:
            return b""
        output = self._decode(b"", limit, final=True)
        if not self._finished:
            raise _CompressionReadError("unexpected end of file")
        return output

    def _decode(self, data: bytes, limit: int, *, final: bool) -> bytes:
        input_buffer = (_BROTLI_U8 * len(data)).from_buffer_copy(data) if data else None
        available_input = ctypes.c_size_t(len(data))
        next_input = ctypes.cast(input_buffer, _BROTLI_U8_POINTER) if input_buffer is not None else _BROTLI_U8_POINTER()
        output = bytearray()
        while len(output) < limit:
            capacity = min(_BROTLI_OUTPUT_CHUNK_BYTES, limit - len(output))
            output_buffer = (_BROTLI_U8 * capacity)()
            available_output = ctypes.c_size_t(capacity)
            next_output = ctypes.cast(output_buffer, _BROTLI_U8_POINTER)
            total_output = ctypes.c_size_t(0)
            result = _BROTLI_LIBRARY.BrotliDecoderDecompressStream(
                self._state,
                ctypes.byref(available_input),
                ctypes.byref(next_input),
                ctypes.byref(available_output),
                ctypes.byref(next_output),
                ctypes.byref(total_output),
            )
            output.extend(bytes(output_buffer[: capacity - available_output.value]))
            if result == _BROTLI_ERROR:
                raise _CompressionReadError("Decompression failed")
            if result == _BROTLI_SUCCESS:
                self._finished = True
                return bytes(output)
            if result == _BROTLI_NEEDS_MORE_INPUT:
                if final:
                    raise _CompressionReadError("unexpected end of file")
                return bytes(output)
            if result != _BROTLI_NEEDS_MORE_OUTPUT:  # pragma: no cover - C API has four result values.
                raise _CompressionReadError("Decompression failed")
        return bytes(output)

    def close(self) -> None:
        if self._state is not None:
            _BROTLI_LIBRARY.BrotliDecoderDestroyInstance(self._state)
            self._state = None


def _body_decoder(content_encoding: str) -> _IdentityBodyDecoder | _ZlibBodyDecoder | _BrotliBodyDecoder:
    if content_encoding == "identity":
        return _IdentityBodyDecoder()
    if content_encoding == "gzip":
        return _ZlibBodyDecoder(16 + zlib.MAX_WBITS)
    if content_encoding == "deflate":
        return _ZlibBodyDecoder(zlib.MAX_WBITS)
    if content_encoding == "br":
        return _BrotliBodyDecoder()
    raise UnsupportedContentEncoding(content_encoding)


class RequestIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").casefold(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        # nestjs-pino only replaces an exactly-empty request id.  Whitespace is
        # observable in both the response header and request log, so it must
        # not be normalized here.
        request_id = headers.get("x-request-id", "")
        if request_id == "":
            import uuid

            request_id = str(uuid.uuid4())
        token = request_id_context.set(request_id)
        status_code: int | None = None

        async def with_header(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
                raw_headers = list(message.get("headers", []))
                raw_headers.append((b"x-request-id", request_id.encode("latin-1", errors="replace")))
                message["headers"] = raw_headers
            await send(message)

        try:
            await self.app(scope, receive, with_header)
        finally:
            app = scope.get("app")
            logger = getattr(getattr(app, "state", None), "logger", None)
            if logger is not None and scope.get("path") != "/health" and status_code is not None:
                log_event(
                    logger,
                    logging.INFO,
                    "http.request",
                    req={"id": request_id, "method": scope.get("method"), "url": scope.get("path")},
                    res={"statusCode": status_code},
                )
            request_id_context.reset(token)


class InternalJsonParserMiddleware:
    """Apply Express-json semantics before the internal API-key guard."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or scope.get("path") not in {"/internal/v1/geo/generations", "/internal/v1/geo/test-generations"}
        ):
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").casefold(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        state = scope.setdefault("state", {})
        state["neo_internal_json"] = None
        # type-is skips unframed requests before examining Content-Type.
        if "content-length" not in headers and "transfer-encoding" not in headers:
            await self.app(scope, receive, send)
            return
        content_type = headers.get("content-type", "")
        try:
            should_parse = is_express_json_media_type(content_type)
        except TypeError:
            # Nest exposes its generic envelope for media-typer's TypeError,
            # before the API-key guard gets a chance to run.
            response = legacy_error(500, "Internal server error")
            await response(scope, receive, send)
            return
        if not should_parse:
            await self.app(scope, receive, send)
            return
        _, charset = content_type_parts(content_type)

        # body-parser validates charset before constructing/decompressing the
        # content stream.  Its 415 envelope comes from the global Nest filter,
        # not FastAPI's generic HTTPException shape.
        if charset and not charset.startswith("utf-"):
            response = legacy_error(415, f'unsupported charset "{charset.upper()}"')
            await response(scope, receive, send)
            return

        content_encoding = (headers.get("content-encoding") or "identity").casefold()
        try:
            decoder = _body_decoder(content_encoding)
        except UnsupportedContentEncoding as exc:
            response = legacy_error(415, f'unsupported content encoding "{exc.encoding}"')
            await response(scope, receive, send)
            return

        # ``raw-body`` limits the *inflated* stream.  Keep only bounded
        # decoded data for JSON.parse and never retain the compressed request
        # messages, which otherwise lets a gzip/brotli bomb allocate before
        # the check runs.
        decoded = bytearray()

        def append_decoded(chunk: bytes) -> None:
            if len(chunk) > _MAX_BODY_BYTES - len(decoded):
                raise _BodyTooLarge
            decoded.extend(chunk)

        try:
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    raise _CompressionReadError("request aborted")
                if message["type"] != "http.request":
                    continue
                chunk = bytes(cast(bytes, message.get("body", b"")))
                append_decoded(decoder.feed(chunk, _MAX_BODY_BYTES + 1 - len(decoded)))
                if not message.get("more_body", False):
                    break
            append_decoded(decoder.finish(_MAX_BODY_BYTES + 1 - len(decoded)))
        except _BodyTooLarge:
            response = legacy_error(413, "request entity too large")
            await response(scope, receive, send)
            return
        except _CompressionReadError as exc:
            # A malformed/completed-abruptly contentstream fails before auth
            # and DTO validation, exactly like Express/body-parser.
            response = legacy_validation_error(str(exc) or "Bad Request")
            await response(scope, receive, send)
            return
        finally:
            decoder.close()

        try:
            payload = parse_express_json_body(bytes(decoded), charset)
        except UnsupportedJsonCharset as exc:
            response = legacy_error(415, str(exc))
            await response(scope, receive, send)
            return
        except JsonRequestParseError as exc:
            response = legacy_validation_error(str(exc))
            await response(scope, receive, send)
            return
        state["neo_internal_json"] = payload

        async def replay_receive() -> Message:
            return {"type": "http.request", "body": b"", "more_body": False}

        await self.app(scope, replay_receive, send)


class UnsupportedContentEncoding(ValueError):
    def __init__(self, encoding: str) -> None:
        self.encoding = encoding
        super().__init__(encoding)


class RagProfileStore(Protocol):
    """Structural persistence boundary used by the RAG-profile routes."""

    async def read_extractor(self) -> dict[str, Any]: ...

    async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]: ...

    async def reset_extractor(self) -> dict[str, Any]: ...

    async def read_generator(self) -> dict[str, Any]: ...

    async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]: ...

    async def reset_generator(self) -> dict[str, Any]: ...


class RagProfiles:
    async def read_extractor(self) -> dict[str, Any]:
        return as_dict(await _resolve(read_product_extractor_rag_profile()))

    async def write_extractor(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return as_dict(await _resolve(write_product_extractor_rag_profile(payload)))

    async def reset_extractor(self) -> dict[str, Any]:
        return as_dict(await _resolve(reset_product_extractor_rag_profile()))

    async def read_generator(self) -> dict[str, Any]:
        return as_dict(await _resolve(read_pdp_geo_generator_rag_profile()))

    async def write_generator(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return as_dict(await _resolve(write_pdp_geo_generator_rag_profile(payload)))

    async def reset_generator(self) -> dict[str, Any]:
        return as_dict(await _resolve(reset_pdp_geo_generator_rag_profile()))


async def _resolve(value: object) -> object:
    return await cast(Awaitable[object], value) if inspect.isawaitable(value) else value


def _runtime_from_settings(settings: Settings) -> dict[str, Any]:
    # `/generate` has its own retained Next factory. In particular, it uses
    # primary Azure embedding env fields rather than the worker's dedicated
    # embedding endpoint configuration.
    runtime = dict(settings.generate_console_runtime())
    runtime["citationProbeEnabled"] = settings.citation_probe_enabled
    runtime["_providerDefaults"] = {
        provider: settings.generate_console_runtime(provider)
        for provider in ("mock", "openai", "gemini", "azure-openai", "aistudio")
    }
    return runtime


# Public narrow seam for the retained console-runtime DTO contract.
runtime_from_settings = _runtime_from_settings


def create_app(
    *,
    settings: Settings | None = None,
    generation_repository: Any | None = None,
    queue: Any | None = None,
    generation_service: Any | None = None,
    result_repository: Any | None = None,
    profiles: RagProfileStore | None = None,
) -> FastAPI:
    configured = settings or Settings.from_env()
    logger = configure_logging(configured.log_level)
    database: Database | None = None
    if generation_repository is None or result_repository is None:
        database = create_database(configured.resolved_database_url, schema=configured.db_schema)
    if generation_repository is None:
        assert database is not None
        generations = GeoGenerationRepository(database)
    else:
        generations = generation_repository
    if result_repository is None:
        assert database is not None
        results = GeoResultRepository(database)
    else:
        results = result_repository
    service_queue = queue or GeoQueue(
        concurrency=configured.worker_concurrency,
        # These are module constants in the retained Nest GeoModule.  Keep
        # parsing the legacy env fields for surface compatibility, but do not
        # let them alter the worker's retry policy.
        max_attempts=_QUEUE_MAX_ATTEMPTS,
        backoff_ms=_QUEUE_BACKOFF_MS,
        logger=logger,
    )
    service_generation = generation_service or GenerationService(
        OcrEnrichmentService(
            allowed_hosts_raw=configured.ocr_image_allowed_hosts,
            options=configured.internal_extractor_runtime(),
        ),
        provider=configured.provider,
        runtime=configured.internal_generator_runtime(),
    )
    acceptance = GeoAcceptanceService(generations, service_queue, configured.queue_max_waiting, logger=logger)
    tracer = create_tracer(
        configured.langfuse_public_key,
        configured.langfuse_secret_key,
        configured.langfuse_base_url,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        try:
            if database is not None:
                await database.ensure_ready()
            processor = GeoProcessor(
                service_generation,
                results,
                generations,
                max_attempts=_QUEUE_MAX_ATTEMPTS,
                logger=logger,
            )
            set_handler = getattr(service_queue, "set_handler", None)
            if callable(set_handler):
                set_handler(processor.process)
            yield
        finally:
            shutdown = getattr(service_queue, "shutdown", None)
            if callable(shutdown):
                outcome = shutdown()
                if inspect.isawaitable(outcome):
                    await outcome
            if database is not None:
                await database.dispose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = configured
    app.state.database = database
    app.state.generation_repository = generations
    app.state.result_repository = results
    app.state.queue = service_queue
    app.state.generation_service = service_generation
    app.state.acceptance = acceptance
    app.state.tracer = tracer
    app.state.profiles = profiles or RagProfiles()
    app.state.runtime = _runtime_from_settings(configured)
    app.state.extractor_console_runtime = configured.extractor_console_runtime()
    app.state.generator_console_runtime = configured.generator_console_runtime()
    app.state.console_json = console_json
    app.state.logger = logger
    app.add_exception_handler(LegacyHttpError, legacy_http_exception_handler)
    app.add_exception_handler(Exception, _unhandled_error)
    from fastapi.exceptions import RequestValidationError

    app.add_exception_handler(RequestValidationError, legacy_request_validation_handler)
    # An empty allowlist is intentional: direct browser access is opt-in per
    # deployment.  Add this first so request IDs remain the outermost wrapper
    # and decorate CORS preflight responses too.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(configured.cors_allowed_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Request-ID", "X-Neo-Console", "Cache-Control"],
        expose_headers=["X-Request-ID"],
    )
    # Last added middleware is outermost: request ID must decorate direct 413 responses too.
    # The retained 2 MiB limit belongs to Nest's internal JSON parser.  It
    # must not limit the separately retained Next console Request.json routes.
    app.add_middleware(InternalJsonParserMiddleware)
    app.add_middleware(RequestIdMiddleware)
    app.include_router(internal_router)
    app.include_router(console_router)
    app.include_router(rag_profile_router)
    return app


async def _unhandled_error(request: Any, exc: Exception) -> Response:
    logger = getattr(getattr(getattr(request, "app", None), "state", None), "logger", None)
    if logger is not None:
        log_event(logger, logging.ERROR, "http.unhandled_error", err=str(exc))
    return console_json({"statusCode": 500, "message": "Internal server error"}, 500)


app = create_app()

"""JSON-line logging with conservative secret redaction."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from neo_agent_api._json import as_dict, as_list

from .job_context import current_job_context

_SECRET_KEYS = {"authorization", "api-key", "x-api-key", "apikey", "password", "secret"}


def _redact(value: Any, key: str | None = None) -> Any:
    if key and key.casefold() in _SECRET_KEYS:
        return "[redacted]"
    if isinstance(value, dict):
        return {item_key: _redact(item_value, item_key) for item_key, item_value in as_dict(value).items()}
    if isinstance(value, list):
        return [_redact(item) for item in as_list(value)]
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        message: dict[str, Any] = {
            "level": record.levelname.lower(),
            "time": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "event": getattr(record, "event", record.getMessage()),
        }
        context = current_job_context()
        if context:
            message.update(context)
        extras = getattr(record, "fields", None)
        if isinstance(extras, dict):
            message.update(_redact(extras))
        return json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str)


def configure_logging(level: str = "info") -> logging.Logger:
    logger = logging.getLogger("neo_agent_api")
    logger.handlers.clear()
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.propagate = False
    # Uvicorn is the FastAPI runtime equivalent of Nest's bootstrap logger;
    # route its own records through the same JSON formatter rather than mixing
    # plaintext process logs with structured service events.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        runtime_logger = logging.getLogger(name)
        runtime_logger.handlers.clear()
        runtime_logger.addHandler(handler)
        runtime_logger.setLevel(getattr(logging, level.upper(), logging.INFO))
        runtime_logger.propagate = False
    return logger


def log_event(logger: logging.Logger, level: int, event: str, **fields: Any) -> None:
    logger.log(level, event, extra={"event": event, "fields": fields})

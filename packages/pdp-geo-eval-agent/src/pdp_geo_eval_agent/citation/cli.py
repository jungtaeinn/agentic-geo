"""CLI argument and environment configuration helpers for benchmark scripts."""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence

from neo_js_compat import js_parse_float


def arg_value(args: Sequence[str], flag: str) -> str | None:
    try:
        index = list(args).index(flag)
    except ValueError:
        return None
    return args[index + 1] if index < len(args) - 1 else None


def resolve_engine_config_from_env(provider: str, args: Sequence[str], default_temperature: float = 0.5, *, environ: Mapping[str, str] | None = None) -> dict[str, object]:
    env = os.environ if environ is None else environ
    temperature_arg = arg_value(args, "--temperature")
    temperature = js_parse_float(temperature_arg) if temperature_arg is not None else default_temperature
    if provider == "openai":
        return {"provider": provider, "apiKey": _required_env(env, "OPENAI_API_KEY"), "model": _value_or_required(arg_value(args, "--model"), env, "OPENAI_MODEL"), "temperature": temperature}
    if provider == "gemini":
        return {"provider": provider, "apiKey": _required_env(env, "GEMINI_API_KEY"), "model": _value_or_required(arg_value(args, "--model"), env, "GEMINI_MODEL"), "temperature": temperature}
    if provider == "azure-openai":
        result: dict[str, object] = {"provider": provider, "apiKey": _required_env(env, "AZURE_OPENAI_API_KEY"), "endpoint": _value_or_required(arg_value(args, "--endpoint"), env, "AZURE_OPENAI_ENDPOINT"), "deployment": _value_or_required(arg_value(args, "--deployment"), env, "AZURE_OPENAI_DEPLOYMENT"), "temperature": temperature}
        version = _nullish_or(arg_value(args, "--api-version"), env.get("AZURE_OPENAI_API_VERSION"))
        if version is not None:
            result["apiVersion"] = version
        return result
    if provider == "aistudio":
        result = {"provider": provider, "apiKey": _required_env(env, "AISTUDIO_API_KEY"), "endpoint": _value_or_required(arg_value(args, "--endpoint"), env, "AISTUDIO_ENDPOINT"), "deployment": _value_or_required(arg_value(args, "--deployment"), env, "AISTUDIO_DEPLOYMENT"), "temperature": temperature}
        version = _nullish_or(arg_value(args, "--api-version"), env.get("AISTUDIO_API_VERSION"))
        if version is not None:
            result["apiVersion"] = version
        return result
    raise ValueError(f"Unsupported geo-eval provider: {provider}")


def _required_env(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name)
    if not value:
        raise OSError(f"Missing required environment variable: {name}")
    return value


def _value_or_required(value: str | None, environ: Mapping[str, str], name: str) -> str:
    """Mirror ``value ?? requiredEnv(name)`` without eager fallback lookup."""
    return _required_env(environ, name) if value is None else value


def _nullish_or(value: str | None, fallback: str | None) -> str | None:
    """Mirror ``value ?? fallback`` instead of Python's truthiness fallback."""
    return fallback if value is None else value

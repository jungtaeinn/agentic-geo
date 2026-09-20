FROM ghcr.io/astral-sh/uv:0.12.11 AS uv

FROM python:3.14.7-slim AS builder

COPY --from=uv /uv /uvx /bin/

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

# PyICU gives the console's model-list ordering the same current ICU collation
# used by Node's String#localeCompare.  CPython 3.14 has no matching wheel, so
# install the small native build surface before uv resolves the workspace.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libicu-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

# The uv workspace resolves the Python agent packages from the repository, so
# keep its source layout intact rather than copying a Node build artifact.
COPY . .
RUN uv sync --frozen --no-dev --package neo-agent-api

FROM python:3.14.7-slim AS runtime

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# PyICU is compiled in the builder, but its extension remains dynamically
# linked to ICU.  Keep only that runtime library in the serving image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu76 \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system neo-agent-api && adduser --system --ingroup neo-agent-api neo-agent-api

# Workspace packages are installed editable by uv, so retain their source tree
# alongside the already-resolved virtual environment without carrying compiler
# tooling or development headers into the runtime stage.
COPY --from=builder --chown=neo-agent-api:neo-agent-api /app /app
USER neo-agent-api

EXPOSE 3000

# The virtual environment is resolved while root owns the build layer.  Invoke
# its entry point directly so the final system user never asks uv to create a
# cache/home directory at container startup.
CMD ["/app/.venv/bin/uvicorn", "neo_agent_api.main:app", "--host", "0.0.0.0", "--port", "3000"]

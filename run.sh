#!/usr/bin/env bash
# neo-agents 로컬 기동 스크립트 — .env를 준비하고 pnpm 개발 서버를 실행한다.
# (.env / .env.example / .gitignore 컨벤션은 이미 저장소에 구성돼 있음)
# 사용법: ./run.sh [target]
#   geo-generator (기본) | pdp-extractor | agent-api
set -euo pipefail
cd "$(dirname "$0")"

# 루트 .env 준비
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[run.sh] 루트 .env를 생성했습니다(.env.example 복사). 값을 채운 뒤 다시 실행하세요:"
  echo "         $(pwd)/.env"
  exit 1
fi

TARGET="${1:-geo-generator}"

# agent-api(=neo-agent-api)는 자체 .env를 사용한다
if [ "$TARGET" = "agent-api" ] && [ ! -f apps/agent-api/.env ]; then
  cp apps/agent-api/.env.example apps/agent-api/.env
  echo "[run.sh] apps/agent-api/.env를 생성했습니다. 값을 채운 뒤 다시 실행하세요:"
  echo "         $(pwd)/apps/agent-api/.env"
  exit 1
fi

if [ "$TARGET" != "agent-api" ]; then
  echo "[run.sh] 의존성 설치 (pnpm install)"
  pnpm install
fi

case "$TARGET" in
  geo-generator) echo "[run.sh] geo-generator 개발 서버 실행"; exec pnpm dev ;;
  pdp-extractor) echo "[run.sh] pdp-extractor 개발 서버 실행"; exec pnpm dev:pdp-extractor ;;
  agent-api)
    # FastAPI does not load this sibling .env on its own. Export it so the
    # process sees the same established AGENT_API_*/DB_*/provider variables.
    set -a
    # shellcheck disable=SC1091
    source apps/agent-api/.env
    set +a
    echo "[run.sh] neo-agent-api FastAPI 개발 서버 실행"
    exec uv run --package neo-agent-api uvicorn neo_agent_api.main:app \
      --host 0.0.0.0 --port "${PORT:-3000}" --reload
    ;;
  *) echo "[run.sh] 알 수 없는 대상: $TARGET (geo-generator|pdp-extractor|agent-api)"; exit 1 ;;
esac

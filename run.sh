#!/usr/bin/env bash
# agentic-geo 로컬 기동 스크립트 — .env를 준비하고 pnpm 개발 서버를 실행한다.
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

# agent-api(=agentic_geo-agent-api)는 자체 .env를 사용한다
if [ "$TARGET" = "agent-api" ] && [ ! -f apps/agent-api/.env ]; then
  cp apps/agent-api/.env.example apps/agent-api/.env
  echo "[run.sh] apps/agent-api/.env를 생성했습니다. 값을 채운 뒤 다시 실행하세요:"
  echo "         $(pwd)/apps/agent-api/.env"
  exit 1
fi

echo "[run.sh] 의존성 설치 (pnpm install)"
pnpm install

case "$TARGET" in
  geo-generator) echo "[run.sh] geo-generator 개발 서버 실행"; exec pnpm dev ;;
  pdp-extractor) echo "[run.sh] pdp-extractor 개발 서버 실행"; exec pnpm dev:pdp-extractor ;;
  agent-api)
    # NestJS 는 파일 로깅이 내장돼 있지 않아 stdout/stderr 을 tee 로 남긴다(logs/ 는 gitignore).
    # 콘솔은 Nest 컬러 그대로 두고, 파일에는 ANSI 이스케이프를 벗겨 저장한다(grep 가능하게).
    # ANSI 제거에 sed 를 쓰면 안 된다 — BSD sed(macOS) 는 출력이 파일일 때 4KB 블록 버퍼링이라
    # 로그가 4KB 단위로만 flush 되고, Ctrl-C 로 끊으면 마지막 4KB 미만이 통째로 유실된다.
    # (라인 버퍼 플래그는 BSD -l / GNU -u 로 갈려 이식성도 없다.) perl 은 $|=1 로 라인 flush 를 보장한다.
    # exec 은 파이프라인에 걸 수 없어 쓰지 않는다. 종료 코드는 위의 `set -o pipefail` 이 보존한다.
    LOG_DIR="apps/agent-api/logs"
    mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/agent-api-$(date +%F).log"
    echo "[run.sh] agent-api 개발 서버 실행 (로그: $(pwd)/$LOG_FILE)"
    pnpm --filter ./apps/agent-api dev 2>&1 \
      | tee >(perl -pe 'BEGIN{$|=1} s/\e\[[0-9;]*m//g' >> "$LOG_FILE")
    ;;
  *) echo "[run.sh] 알 수 없는 대상: $TARGET (geo-generator|pdp-extractor|agent-api)"; exit 1 ;;
esac

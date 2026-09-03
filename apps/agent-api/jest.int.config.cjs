/**
 * 통합 테스트 전용 jest 설정 — Testcontainers로 실제 Postgres를 띄우는 `*.int-spec.ts`만 잡는다.
 * 로컬 Docker가 필요하므로 기본 `pnpm test`(커밋/CI 경로)에서 분리했다. 실행은 `pnpm test:int`.
 *
 * 스키마는 엔티티 자동생성(synchronize)이 아니라 test/fixtures/geo-schema.sql로 만든다.
 * 그 파일은 upstream-api의 V1__create_geo.sql을 그대로 미러링하므로, 엔티티와 운영 스키마가
 * 어긋나면 여기서 깨진다 — 이 스위트의 존재 이유다.
 *
 * colima/Lima 사용자 주의: Testcontainers가 Ryuk 컨테이너에 macOS 호스트 소켓 경로를
 * 그대로 마운트해 Ryuk이 기동에 실패한다(에러: Log stream ended and message ... was not received).
 * 셸에 `export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`를 넣으면 해결된다.
 * 자세한 내용은 README.md 테스트 섹션 참고.
 */
module.exports = {
  displayName: 'integration',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  transformIgnorePatterns: ['/node_modules/(?!(@agentic-geo)/)'],
  testEnvironment: 'node',
  testTimeout: 120000,
};

/**
 * 기본 jest 설정 — 단위(`*.spec.ts`)와 e2e 계약(`*.e2e-spec.ts`)만 잡는다. Docker가 필요 없다.
 *
 * 통합(`*.int-spec.ts`)은 Testcontainers로 실제 Postgres를 띄우므로 여기서 빼고
 * jest.int.config.cjs(`pnpm test:int`)로 분리했다. 예전에는 이 testRegex가 int-spec까지
 * 잡아서 Docker가 없는 환경에서는 `pnpm test`와 `turbo run test`가 통째로 실패했고,
 * 걸러낼 스위치도 없었다.
 */
module.exports = {
  displayName: 'unit',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  transformIgnorePatterns: ['/node_modules/(?!(@agentic-geo)/)'],
  testEnvironment: 'node',
  testTimeout: 120000,
};

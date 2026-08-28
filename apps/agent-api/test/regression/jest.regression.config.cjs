const { join } = require('node:path');

/**
 * 리그레션 전용 jest 설정.
 *
 * 기본 jest.config.cjs의 testRegex는 (spec|e2e-spec), jest.int.config.cjs는 int-spec만 잡으므로
 * `.reg-spec.ts`는 어느 쪽에도 걸리지 않는다. 즉 `pnpm test`와 turbo test 파이프라인에
 * LLM 비용이 드는 회귀가 섞이지 않는다.
 */
module.exports = {
  displayName: 'geo-regression',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: join(__dirname, '..', '..'),
  testRegex: '.*\\.reg-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  transformIgnorePatterns: ['/node_modules/(?!(@agentic-geo)/)'],
  testEnvironment: 'node',
  // LLM 생성은 케이스당 수 분이 걸릴 수 있다. GEO_REGRESSION_TIMEOUT_MS로 덮어쓴다.
  testTimeout: Number(process.env.GEO_REGRESSION_TIMEOUT_MS ?? 600000),
  // .env 로드와 run id 확정은 globalSetup이 부모 프로세스에서 한 번에 처리한다
  // (워커는 부모의 process.env를 상속하므로 setupFiles가 따로 필요 없다).
  globalSetup: '<rootDir>/test/regression/global-setup.ts',
  globalTeardown: '<rootDir>/test/regression/global-teardown.ts',
};

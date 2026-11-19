import { defineConfig } from 'vitest/config';

// 端到端：真实 Chrome + 本地假 myrta 网站（test/helpers/mock-myrta.ts）。较慢，不在 npm test 里跑
export default defineConfig({
  test: { include: ['test/e2e/**/*.e2e.ts'], testTimeout: 240_000, hookTimeout: 60_000, fileParallelism: false },
});

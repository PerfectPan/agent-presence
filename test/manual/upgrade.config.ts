import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/manual/previous-release-upgrade.ts'],
    testTimeout: 60_000
  }
});

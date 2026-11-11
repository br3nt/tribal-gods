import { defineConfig } from 'vitest/config';

// Only this checkout's tests — agent worktrees under .claude/ carry their own copies.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['.claude/**', 'node_modules/**'] },
});

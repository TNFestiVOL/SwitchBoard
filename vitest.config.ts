import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Agent worktrees live under data/worktrees and carry their own copy of tests/.
  test: { exclude: [...configDefaults.exclude, 'data/**'] },
});

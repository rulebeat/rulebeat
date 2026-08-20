import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const web = resolve(root, 'packages/web');

/**
 * One config, two projects — `core` and `web` — rather than a config file per package, so
 * `npm test` at the root runs everything and coverage is reported across both.
 *
 * `web` tests run in the `node` environment on purpose: the suites here exercise pure logic,
 * repositories and API route handlers, none of which need a DOM. Browser-level behaviour is
 * covered by Playwright (tests/e2e), not by jsdom.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: resolve(root, 'packages/core'),
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: {
          alias: {
            // Mirrors packages/web/tsconfig.json's `@/*` path alias.
            '@': web,
            // next-auth's own lib/env.js does `import { NextRequest } from "next/server"` with no
            // extension. Next's package.json `exports` map only resolves the extensioned form —
            // fine inside Next's own bundler, a hard ESM resolution error under plain Node/Vitest.
            // Only this exact specifier is aliased; nothing else about module resolution changes.
            'next/server': resolve(root, 'node_modules/next/server.js'),
          },
        },
        test: {
          name: 'web',
          root: web,
          include: ['tests/**/*.test.ts'],
          environment: 'node',
          // Every DB-backed suite opens its own temp database via tests/helpers/db.ts. Sharing one
          // process across files would share the module-level SQLite singleton too, so files must
          // not run in the same worker concurrently.
          fileParallelism: false,
          setupFiles: ['./tests/setup.ts'],
          server: {
            deps: {
              // Vitest resolves node_modules imports through Node's native loader by default, which
              // skips the resolve.alias above entirely. next-auth's own lib/env.js does an
              // extensionless `import ... from "next/server"`, which only Next's bundler tolerates —
              // "inlining" routes it through Vite's resolver instead, where the alias applies.
              inline: ['next-auth'],
            },
          },
        },
      },
    ],
    // Locally: the normal readable output. In CI: the same, plus GitHub annotations (a failure is
    // marked inline on the offending line, no third-party action needed) and a JUnit XML file.
    // JUnit's XML format started in the Java world but became the format every CI system reads, so
    // it's what makes a run's per-test results readable and archivable rather than one red tick.
    reporters: process.env.CI
      ? ['default', 'github-actions', 'junit']
      : ['default'],
    outputFile: { junit: resolve(root, 'test-results/junit.xml') },

    coverage: {
      provider: 'v8',
      reportsDirectory: resolve(root, 'coverage'),
      reporter: ['text', 'html', 'lcov'],
      include: [
        'packages/core/src/**/*.ts',
        'packages/web/lib/**/*.ts',
        'packages/web/app/api/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts', 'packages/core/dist/**'],
    },
  },
});

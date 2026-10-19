'use strict';
// eslint for the repo's JavaScript (spec 2026-09-23-ci-safety-net-design D2): `npm run lint`, and CI's lint job.
// The HUD's TypeScript is checked by tsc instead (`npm run typecheck`).
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  // Hooks and best-effort writes swallow errors on purpose: a hook must never fail a session.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Callback and catch parameters document the shape; a leading underscore marks a deliberate unused binding.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  // The sanitizers strip NUL and ANSI escapes on purpose, and table-output tests match column padding literally.
  'no-control-regex': 'off',
  'no-regex-spaces': 'off',
};
const languageOptions = (sourceType) => ({ ecmaVersion: 2023, sourceType, globals: { ...globals.node } });

module.exports = [
  // Generated or bundled output, the HUD's TypeScript sources (tsc), and the gitignored private *.local.* files. The app's
  // TypeScript is checked by its own tsc (`npm run typecheck` in app/); its .js/.cjs/.mjs scripts are linted here.
  { ignores: ['**/node_modules/**', 'codex-plugin/**', 'hud/src/**', '**/*.local.*',
    // The app's build output, packages, test runs and generated fixture vault (app/.gitignore).
    'app/out/**', 'app/out-test/**', 'app/dist/**', 'app/dist-test/**', 'app/test-results/**', 'app/playwright-report/**', 'app/tests/.fixture/**', 'app/tests/.cache/**', 'app/payload/**'] },
  { files: ['**/*.js', '**/*.cjs'], languageOptions: languageOptions('commonjs'), rules },
  { files: ['**/*.mjs'], languageOptions: languageOptions('module'), rules },
  // The app's Playwright drivers: the functions they hand to evaluate() run in the app's window.
  { files: ['app/scripts/smoke-packaged.mjs'], languageOptions: { globals: { ...globals.browser } } },
];

// @ts-check
import stylistic from '@stylistic/eslint-plugin';
import { angular, electron, typescriptStandards, typescriptTests, typescriptTypeChecked } from '@wigtertainment-ltd/eslint-config';
import { defineConfig } from 'eslint/config';
import electronSecurity from 'eslint-plugin-electron-security';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';

const typescriptFiles = ['**/*.{ts,cts,mts,tsx}'];
const electronProfiles = electron({
  main: ['electron/**/*'],
  preload: ['electron/**/preload.{ts,cts,mts,js,cjs,mjs}'],
  renderer: ['src/**/*', 'electron/**/renderer.{ts,cts,mts,js,cjs,mjs}', 'electron/extraction/{geometry,image-input}.ts'],
});
const explicitTypeRestrictions = [
  { selector: 'AccessorProperty:not([typeAnnotation])', message: 'Declare an explicit type for this class field.' },
  { selector: 'CatchClause[param]:not([param.typeAnnotation])', message: 'Declare an explicit type for this catch binding.' },
];
// ESLint replaces rule options, so retain the Electron restrictions when adding ReceiptMatch's TypeScript selectors.
const electronTypeScriptRestrictions = electronProfiles.flatMap(({ name, files, ignores, rules }) => {
  const restrictions = rules?.['no-restricted-syntax'];
  if (!Array.isArray(restrictions)) {
    return [];
  }
  return defineConfig({ name: `${name}/receiptmatch`, files, ignores, rules: { 'no-restricted-syntax': ['error', ...restrictions.slice(1), ...explicitTypeRestrictions] } });
});

const constFunction = 'VariableDeclaration[kind="const"]:has(VariableDeclarator:matches([init.type="ArrowFunctionExpression"], [init.type="FunctionExpression"]))';
const functionStatements = {
  selector: [
    'FunctionDeclaration',
    ':matches(ExportDefaultDeclaration, ExportNamedDeclaration)[declaration.type="FunctionDeclaration"]',
    constFunction,
    `ExportNamedDeclaration:has(${constFunction})`,
  ].join(', '),
};
const callbackCalls = [
  {
    selector: 'ExpressionStatement[expression.type="CallExpression"][expression.callee.object.name="ipcMain"][expression.callee.property.name="handle"]',
  },
  {
    selector: 'ExpressionStatement:has(> CallExpression:has(> ArrowFunctionExpression.arguments, > FunctionExpression.arguments))',
    lineMode: /** @type {const} */ ('multiline'),
  },
];

export default defineConfig([
  { ignores: ['**/dist/**', '**/release/**', 'tmp/**', '**/.angular/**', '**/.build/**', '**/artifacts/**', '**/coverage/**', '**/node_modules/**'] },
  typescriptStandards({ tsconfigRootDir: import.meta.dirname }),
  {
    files: ['**/*.{js,mjs,cjs}'],
    ignores: ['src/**', 'electron/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.ts', 'electron/preview/renderer.ts', '**/*.html'],
    extends: [angular()],
  },
  electronProfiles,
  typescriptTypeChecked({
    tsconfigRootDir: import.meta.dirname,
    project: ['./tsconfig.app.json', './tsconfig.preview.json', './tsconfig.electron.json', './tsconfig.tests.json', './tsconfig.playwright.json'],
  }),
  typescriptTests.map((config) => ({ ...config, files: [...(config.files ?? []), 'tests/unit/**/*.test.ts'] })),
  {
    files: typescriptFiles,
    extends: [{ rules: { 'no-restricted-syntax': ['error', ...explicitTypeRestrictions] } }, ...electronTypeScriptRestrictions],
    rules: {
      '@typescript-eslint/consistent-generic-constructors': ['error', 'type-annotation'],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,cts,mts,tsx}'],
    plugins: { 'receiptmatch-style': stylistic, sonarjs },
    rules: {
      'receiptmatch-style/brace-style': ['error', '1tbs', { allowSingleLine: false }],
      'receiptmatch-style/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: functionStatements, next: functionStatements },
        { blankLine: 'always', prev: callbackCalls, next: callbackCalls },
      ],
      'receiptmatch-style/lines-between-class-members': ['error', { enforce: [{ blankLine: 'always', prev: 'method', next: 'method' }] }],
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
  {
    files: ['electron/**/*.{js,mjs,cjs,ts,cts}'],
    extends: [electronSecurity.configs.recommended],
  },
  {
    files: ['electron/**/*.{ts,cts,mts,tsx}'],
    rules: electronSecurity.configs['recommended-type-checked'].rules,
  },
]);

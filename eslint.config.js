// @ts-check
import eslint from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import electronSecurity from 'eslint-plugin-electron-security';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import globals from 'globals';

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
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [eslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts', '**/*.cts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked, angular.configs.tsRecommended],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.preview.json', './tsconfig.electron.json', './tsconfig.tests.json', './tsconfig.playwright.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error', { allowTypedFunctionExpressions: false, allowHigherOrderFunctions: false, allowDirectConstAssertionInArrowFunctions: false },
      ],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/consistent-generic-constructors': ['error', 'type-annotation'],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'VariableDeclaration:not(ForInStatement > .left, ForOfStatement > .left) > VariableDeclarator:not([id.typeAnnotation])',
          message: 'Declare an explicit type for this variable.',
        },
        {
          selector: ':matches(PropertyDefinition, AccessorProperty):not([typeAnnotation])',
          message: 'Declare an explicit type for this class field.',
        },
        {
          selector: ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > .params:not([typeAnnotation], [left.typeAnnotation], TSParameterProperty)',
          message: 'Declare an explicit type for this parameter.',
        },
        {
          selector: 'TSParameterProperty:not([parameter.typeAnnotation], [parameter.left.typeAnnotation])',
          message: 'Declare an explicit type for this parameter property.',
        },
        {
          selector: 'CatchClause[param]:not([param.typeAnnotation])',
          message: 'Declare an explicit type for this catch binding.',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,cts}'],
    plugins: { '@stylistic': stylistic, sonarjs },
    rules: {
      curly: ['error', 'all'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: functionStatements, next: functionStatements },
        { blankLine: 'always', prev: callbackCalls, next: callbackCalls },
      ],
      '@stylistic/lines-between-class-members': ['error', { enforce: [{ blankLine: 'always', prev: 'method', next: 'method' }] }],
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
  {
    files: ['electron/**/*.{js,mjs,cjs,ts,cts}'],
    extends: [electronSecurity.configs.recommended],
  },
  {
    files: ['electron/**/*.{ts,cts}'],
    rules: electronSecurity.configs['recommended-type-checked'].rules,
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
  }
]);

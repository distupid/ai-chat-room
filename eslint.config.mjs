/**
 * ESLint flat config（A4 维护）。
 * - 全局：eslint:recommended，ESM，Node 环境变量
 * - src/frontend/**、src/backend/dashboard/**：追加浏览器 + Chrome 扩展（MV3）全局变量
 * - 不检查生成物：src/frontend/shared/（由 scripts/sync-shared.js 从 contracts/ 生成，检查源头即可）
 * - 存量豁免：src/ 下 no-useless-assignment / no-useless-escape / no-control-regex /
 *   no-unused-vars 暂降为 warn（A2/A3 lane 的历史代码，测试全绿；待各负责人清理后收紧为 error）
 */
import js from '@eslint/js';

/** Node 22 全局变量（flat config 下需显式声明） */
const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FormData: 'readonly',
  Headers: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  performance: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  crypto: 'readonly',
};

/** 浏览器 + Chrome 扩展（MV3）全局变量 */
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  getComputedStyle: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly',
  DOMParser: 'readonly',
  XMLSerializer: 'readonly',
  Node: 'readonly',
  Element: 'readonly',
  HTMLElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLTextAreaElement: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  InputEvent: 'readonly',
  FileReader: 'readonly',
  btoa: 'readonly',
  atob: 'readonly',
  WebSocket: 'readonly',
  XMLHttpRequest: 'readonly',
  Notification: 'readonly',
  // 内容脚本之间约定的全局命名（经典脚本挂载到 globalThis）
  ChatGPTBridgeObserver: 'readonly',
  ChatGPTBridgeActions: 'readonly',
  // Chrome 扩展 API（MV3：background / content / popup）
  chrome: 'readonly',
};

export default [
  { ignores: ['**/node_modules/**', 'src/frontend/shared/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      // 团队约定：下划线开头的参数表示故意不用
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(_|e)$',
      }],
    },
  },
  {
    files: ['src/frontend/**/*.js', 'src/backend/dashboard/**/*.js'],
    languageOptions: { globals: browserGlobals },
  },
  {
    // 存量豁免（见文件头注释）：只降级，不关闭，CI 日志里仍可见
    files: ['src/**/*.js'],
    rules: {
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^(_|e)$',
      }],
    },
  },
];

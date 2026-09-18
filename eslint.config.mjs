import tsParser from "@typescript-eslint/parser";
import sonarjs from "eslint-plugin-sonarjs";

const sonarRecommended = sonarjs.configs.recommended;
const sonarErrors = Object.fromEntries(
  Object.entries(sonarRecommended.rules).map(([ruleName, setting]) => [
    ruleName,
    Array.isArray(setting) ? ["error", ...setting.slice(1)] : "error",
  ]),
);

export default [
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  },
  {
    ...sonarRecommended,
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2024,
      parser: tsParser,
      sourceType: "module",
      // Web-platform primitives used by the shared browser/Node implementation.
      // Do not grant src/** Node-only or DOM globals (KA-3, FC-3).
      globals: {
        TextEncoder: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: sonarErrors,
  },
  {
    files: ["test/**/*.ts"],
    // Vitest runs in bare Node, not a DOM environment. Tests import Vitest APIs.
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
      },
    },
  },
];

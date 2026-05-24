// Flat ESLint config (ESLint v9). Applies to TypeScript across the monorepo.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-types/**",
      "**/build/**",
      "**/out/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      ".kiro/**",
      "src-tauri/**",
      "**/src-tauri/**",
    ],
  },

  // Base JS recommended rules apply to all JS/TS.
  js.configs.recommended,

  // Type-checked rules ONLY for TypeScript source files in the monorepo.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
  })),

  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // Test files: relax a few strict checks.
  {
    files: ["apps/**/*.{test,spec}.{ts,tsx}", "packages/**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  // Plain JS/MJS config files at repo root: don't apply type-aware rules.
  {
    files: ["*.{js,mjs,cjs}"],
    languageOptions: {
      sourceType: "module",
    },
  },

  // Node.js scripts (build helpers under scripts/). Provide Node globals
  // so `console`, `process`, etc. resolve under the base `no-undef` rule.
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: {
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },

  prettier,
];

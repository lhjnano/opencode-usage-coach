// ESLint 10 flat config — opencode-usage-coach
// TypeScript + Solid.js (TSX) + Bun + tsup
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid";
import globals from "globals";

export default tseslint.config(
  // --- 글로벌 무시 ---
  {
    ignores: ["dist/**", "node_modules/**", "bun.lock"],
  },

  // --- 기본 추천 규칙 ---
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- Solid.js (TSX) ---
  {
    files: ["src/**/*.tsx", "test/**/*.tsx"],
    ...solid.configs["flat/recommended"],
  },

  // --- 모든 TS/TSX 소스 ---
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.bun,
      },
    },
    rules: {
      // 타입스크립트: 프로젝트 성격(코칕 로직)에 맞게 완화
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // 일반 규칙
      "no-unused-vars": "off", // typescript-eslint 버전으로 위임
      "prefer-const": "error",
      eqeqeq: ["warn", "smart"],
      // console.* → TUI에 stderr/stdout이 섞여 나오는 것을 방지.
      // 소스 코드에서는 파일 로거(wsLog/log)를 사용해야 함.
      "no-console": "error",
    },
  },

  // --- 테스트 파일 ---
  {
    files: ["test/**/*.ts", "test/**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.bun,
        ...globals.jest,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // --- 스크립트 (.mjs) ---
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
  },

  // --- CLI 도구 (src/cli.ts) — 콘솔 출력이 정상 동작 (사용자Facing CLI) ---
  {
    files: ["src/cli.ts"],
    rules: {
      "no-console": "off",
    },
  },
);

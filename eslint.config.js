export default [
  {
    ignores: ["node_modules/**", "dist/**", "data/**"],
  },
  {
    files: ["src/**/*.js", "scripts/**/*.js", "tests/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "constructor-super": "error",
      eqeqeq: ["error", "always"],
      "no-async-promise-executor": "error",
      "no-constant-binary-expression": "error",
      "no-duplicate-imports": "error",
      "no-self-assign": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-useless-catch": "error",
      "prefer-const": "error",
    },
  },
];

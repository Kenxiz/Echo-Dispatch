import { defineConfig } from "vitest/config";
var vitest_config_default = defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
export { vitest_config_default as default };

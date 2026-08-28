import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "**/*.config.js", "**/*.config.cjs", "**/*.config.mjs"] },
  ...tseslint.configs.recommended
);

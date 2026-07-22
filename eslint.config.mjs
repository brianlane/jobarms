import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: ["coverage/**", ".next/**", "node_modules/**", "workers/**", "**/*.d.mts"] },
  ...nextVitals
];

export default config;

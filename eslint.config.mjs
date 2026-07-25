import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  // workers/ and vps/ are separate package trees with their own tsconfigs and
  // test suites; the Next.js ruleset here does not apply to them.
  {
    ignores: ["coverage/**", ".next/**", "node_modules/**", "workers/**", "vps/**", "**/*.d.mts"]
  },
  ...nextVitals
];

export default config;

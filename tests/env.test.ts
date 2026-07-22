import { describe, expect, it } from "vitest";
import { appUrl, envOr, requireEnv } from "@/lib/env";

describe("env helpers", () => {
  it("requireEnv returns a set variable", () => {
    process.env.JOBARMS_TEST_VAR = "hello";
    expect(requireEnv("JOBARMS_TEST_VAR")).toBe("hello");
    delete process.env.JOBARMS_TEST_VAR;
  });

  it("requireEnv throws on missing variable", () => {
    delete process.env.JOBARMS_TEST_MISSING;
    expect(() => requireEnv("JOBARMS_TEST_MISSING")).toThrow(
      "Missing required environment variable: JOBARMS_TEST_MISSING"
    );
  });

  it("envOr falls back when unset or empty", () => {
    delete process.env.JOBARMS_TEST_OPT;
    expect(envOr("JOBARMS_TEST_OPT", "fallback")).toBe("fallback");
    process.env.JOBARMS_TEST_OPT = "";
    expect(envOr("JOBARMS_TEST_OPT", "fallback")).toBe("fallback");
    process.env.JOBARMS_TEST_OPT = "set";
    expect(envOr("JOBARMS_TEST_OPT", "fallback")).toBe("set");
    delete process.env.JOBARMS_TEST_OPT;
  });

  it("appUrl defaults to localhost in tests (live env stripped)", () => {
    expect(appUrl()).toBe("http://localhost:3000");
  });
});

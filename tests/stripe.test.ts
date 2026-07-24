import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stripeCtor = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    constructor(...args: unknown[]) {
      stripeCtor(...args);
    }
  }
}));

describe("stripeClient", () => {
  beforeEach(() => {
    vi.resetModules();
    stripeCtor.mockClear();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it("constructs once with the secret key and caches the singleton", async () => {
    const { stripeClient } = await import("@/lib/stripe");
    const a = stripeClient();
    const b = stripeClient();
    expect(a).toBe(b);
    expect(stripeCtor).toHaveBeenCalledTimes(1);
    expect(stripeCtor).toHaveBeenCalledWith("sk_test_123");
  });

  it("throws when STRIPE_SECRET_KEY is missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { stripeClient } = await import("@/lib/stripe");
    expect(() => stripeClient()).toThrow(/STRIPE_SECRET_KEY/);
  });
});

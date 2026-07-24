import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const stripe = vi.hoisted(() => ({
  customers: { create: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  billingPortal: { sessions: { create: vi.fn() } }
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/stripe", () => ({ stripeClient: () => stripe }));

import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";

const post = (body?: unknown) =>
  new Request("http://x", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  vi.clearAllMocks();
  process.env.STRIPE_PRICE_PREMIUM_MONTHLY = "price_premium";
  process.env.STRIPE_PRICE_MAX_MONTHLY = "price_max";
  process.env.NEXT_PUBLIC_APP_URL = "https://jobarms.com";
});

describe("POST /api/billing/checkout", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await checkout(post({}))).status).toBe(401);
  });

  it("400 on an invalid tier", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await checkout(post({ tier: "platinum" }))).status).toBe(400);
  });

  it("creates a customer when none exists, then a checkout session", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: "a@b.com" } });
    holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ data: { stripe_customer_id: null } }] }) });
    stripe.customers.create.mockResolvedValueOnce({ id: "cus_1" });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://checkout" });
    const res = await checkout(post({ tier: "premium" }));
    expect((await res.json()).url).toBe("https://checkout");
    expect(stripe.customers.create).toHaveBeenCalled();
    expect(stripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price).toBe("price_premium");
  });

  it("creates a customer with no email when the user has none", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: undefined } });
    holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ data: { stripe_customer_id: null } }] }) });
    stripe.customers.create.mockResolvedValueOnce({ id: "cus_2" });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://c" });
    await checkout(post({ tier: "premium" }));
    expect(stripe.customers.create.mock.calls[0][0].email).toBeUndefined();
  });

  it("reuses an existing customer and honors the max tier price", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: "a@b.com" } });
    holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ data: { stripe_customer_id: "cus_existing" } }] }) });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://checkout-max" });
    const res = await checkout(post({ tier: "max" }));
    expect((await res.json()).url).toBe("https://checkout-max");
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price).toBe("price_max");
  });

  it("defaults to premium when the body is empty", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: undefined } });
    holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ data: { stripe_customer_id: "cus_1" } }] }) });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ url: "https://c" });
    const res = await checkout(post());
    expect(res.status).toBe(200);
  });
});

describe("POST /api/billing/portal", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await portal()).status).toBe(401);
  });

  it("400 when there is no Stripe customer", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ data: { stripe_customer_id: null } }] }) });
    expect((await portal()).status).toBe(400);
  });

  it("opens the portal for a known customer", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ data: { stripe_customer_id: "cus_1" } }] }) });
    stripe.billingPortal.sessions.create.mockResolvedValueOnce({ url: "https://portal" });
    expect((await (await portal()).json()).url).toBe("https://portal");
  });
});

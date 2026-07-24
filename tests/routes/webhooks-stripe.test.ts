import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ service: null as unknown }));
const stripe = vi.hoisted(() => ({
  webhooks: { constructEvent: vi.fn() },
  subscriptions: { retrieve: vi.fn() }
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/stripe", () => ({ stripeClient: () => stripe }));

import { POST } from "@/app/api/webhooks/stripe/route";

const SUB = {
  id: "sub_1",
  status: "active",
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1_790_000_000, price: { id: "price_x", lookup_key: "jobarms_premium_monthly_19" } }] }
};
const req = (body = "raw") => new Request("http://x", { method: "POST", headers: { "stripe-signature": "sig" }, body });

beforeEach(() => {
  holder.service = fakeClient({ from: fakeFrom({ subscriptions: [{ error: null }, { error: null }] }) });
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
});

describe("POST /api/webhooks/stripe", () => {
  it("400 on a bad signature", async () => {
    stripe.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error("bad sig");
    });
    const res = await POST(req());
    expect(res.status).toBe(400);
  });

  it("checkout.session.completed upserts the subscription", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "u1", customer: "cus_1", subscription: "sub_1" } }
    });
    stripe.subscriptions.retrieve.mockResolvedValueOnce(SUB);
    const from = fakeFrom({ subscriptions: [{ error: null }] });
    holder.service = fakeClient({ from });
    const res = await POST(req());
    expect((await res.json()).received).toBe(true);
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1");
    expect(from).toHaveBeenCalledWith("subscriptions");
  });

  it("400 when the signature header is absent", async () => {
    stripe.webhooks.constructEvent.mockImplementationOnce(() => {
      throw new Error("no sig");
    });
    const noSig = new Request("http://x", { method: "POST", body: "raw" });
    expect((await POST(noSig)).status).toBe(400);
  });

  it("checkout.session.completed with a non-string customer stores a null customer id", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "u1", customer: null, subscription: "sub_1" } }
    });
    stripe.subscriptions.retrieve.mockResolvedValueOnce(SUB);
    expect((await POST(req())).status).toBe(200);
  });

  it("checkout.session.completed without a subscription id is ignored", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "u1", customer: "cus_1", subscription: null } }
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("customer.subscription.updated updates by customer id", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "customer.subscription.updated",
      data: { object: { ...SUB, customer: "cus_1" } }
    });
    const res = await POST(req());
    expect((await res.json()).received).toBe(true);
  });

  it("subscription event without a string customer is skipped", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "customer.subscription.created",
      data: { object: { ...SUB, customer: { id: "obj" } } }
    });
    expect((await POST(req())).status).toBe(200);
  });

  it("customer.subscription.deleted clears the subscription", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "customer.subscription.deleted",
      data: { object: { ...SUB, customer: "cus_1" } }
    });
    expect((await POST(req())).status).toBe(200);
  });

  it("deleted event without a string customer is skipped", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: "customer.subscription.deleted",
      data: { object: { ...SUB, customer: null } }
    });
    expect((await POST(req())).status).toBe(200);
  });

  it("acknowledges unhandled event types", async () => {
    stripe.webhooks.constructEvent.mockReturnValueOnce({ type: "invoice.paid", data: { object: {} } });
    expect((await (await POST(req())).json()).received).toBe(true);
  });
});

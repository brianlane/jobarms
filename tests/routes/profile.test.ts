import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "../helpers/supabase";

const holder = vi.hoisted(() => ({ server: null as unknown, service: null as unknown }));
const sendWelcomeEmail = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => holder.server) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceClient: vi.fn(() => holder.service) }));
vi.mock("@/lib/email", () => ({ sendWelcomeEmail }));

import { PATCH } from "@/app/api/profile/route";

const patch = (body: unknown) =>
  new Request("http://x", { method: "PATCH", body: JSON.stringify(body) });

beforeEach(() => {
  holder.server = null;
  holder.service = null;
  sendWelcomeEmail.mockClear();
  sendWelcomeEmail.mockResolvedValue(true);
});

describe("PATCH /api/profile", () => {
  it("401 without a user", async () => {
    holder.server = fakeClient({ user: null });
    expect((await PATCH(patch({ headline: "x" }))).status).toBe(401);
  });

  it("400 on an invalid body", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    expect((await PATCH(patch({ arm_autonomy: "bogus" }))).status).toBe(400);
  });

  it("400 when the JSON is unparseable", async () => {
    holder.server = fakeClient({ user: { id: "u1" } });
    const bad = new Request("http://x", { method: "PATCH", body: "{" });
    expect((await PATCH(bad)).status).toBe(400);
  });

  it("updates the profile and returns ok", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ profiles: [{ error: null }] }) });
    const res = await PATCH(patch({ headline: "Staff Engineer" }));
    expect((await res.json()).ok).toBe(true);
  });

  it("500 when the update fails", async () => {
    holder.server = fakeClient({ user: { id: "u1" }, from: fakeFrom({ profiles: [{ error: { message: "boom" } }] }) });
    expect((await PATCH(patch({ headline: "x" }))).status).toBe(500);
  });

  it("sends the welcome email once when onboarding completes", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: "a@b.com" }, from: fakeFrom({ profiles: [{ error: null }] }) });
    holder.service = fakeClient({
      from: fakeFrom({ profiles: [{ data: { full_name: "Bri Lane", welcome_sent: false } }, { error: null }] })
    });
    const res = await PATCH(patch({ onboarding_complete: true }));
    expect(res.status).toBe(200);
    expect(sendWelcomeEmail).toHaveBeenCalledWith("a@b.com", "Bri");
  });

  it("greets with an empty name when full_name is null", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: "a@b.com" }, from: fakeFrom({ profiles: [{ error: null }] }) });
    holder.service = fakeClient({
      from: fakeFrom({ profiles: [{ data: { full_name: null, welcome_sent: false } }, { error: null }] })
    });
    await PATCH(patch({ onboarding_complete: true }));
    expect(sendWelcomeEmail).toHaveBeenCalledWith("a@b.com", "");
  });

  it("does not resend the welcome email when already sent", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: "a@b.com" }, from: fakeFrom({ profiles: [{ error: null }] }) });
    holder.service = fakeClient({ from: fakeFrom({ profiles: [{ data: { full_name: "Bri", welcome_sent: true } }] }) });
    await PATCH(patch({ onboarding_complete: true }));
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it("does not mark welcome_sent when the email send fails", async () => {
    sendWelcomeEmail.mockResolvedValueOnce(false);
    const update = { error: null };
    holder.server = fakeClient({ user: { id: "u1", email: "a@b.com" }, from: fakeFrom({ profiles: [update] }) });
    holder.service = fakeClient({ from: fakeFrom({ profiles: [{ data: { full_name: "", welcome_sent: false } }] }) });
    const res = await PATCH(patch({ onboarding_complete: true }));
    expect(res.status).toBe(200);
    expect(sendWelcomeEmail).toHaveBeenCalledWith("a@b.com", "");
  });

  it("skips the welcome email when the user has no email", async () => {
    holder.server = fakeClient({ user: { id: "u1", email: undefined }, from: fakeFrom({ profiles: [{ error: null }] }) });
    await PATCH(patch({ onboarding_complete: true }));
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });
});

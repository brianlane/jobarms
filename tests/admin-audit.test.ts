import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, fakeFrom } from "./helpers/supabase";

const holder = vi.hoisted(() => ({ service: null as unknown }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: vi.fn(() => {
    if (holder.service === "throw") throw new Error("no service key");
    return holder.service;
  })
}));

import { auditActionLabel, listAdminAuditLog, logAdminAction } from "@/lib/admin/audit";

beforeEach(() => {
  holder.service = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("logAdminAction", () => {
  it("writes the row with nulled optional targets", async () => {
    const from = fakeFrom({ admin_audit_log: [{ data: null, error: null }] });
    holder.service = fakeClient({ from });
    await logAdminAction({ adminEmail: "ops@jobarms.com", action: "comp_plan" });

    const insert = from.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledWith({
      admin_email: "ops@jobarms.com",
      action: "comp_plan",
      target_user_id: null,
      target_run_id: null,
      detail: {}
    });
  });

  it("carries targets and detail through", async () => {
    const from = fakeFrom({ admin_audit_log: [{ data: null, error: null }] });
    holder.service = fakeClient({ from });
    await logAdminAction({
      adminEmail: "ops@jobarms.com",
      action: "refund_run",
      targetUserId: "u1",
      targetRunId: "r1",
      detail: { reason: "worker missed it" }
    });

    const insert = from.mock.results[0].value.insert as ReturnType<typeof vi.fn>;
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ target_user_id: "u1", target_run_id: "r1", detail: { reason: "worker missed it" } })
    );
  });

  it("swallows a write error so the audited action still succeeds", async () => {
    holder.service = fakeClient({
      from: fakeFrom({ admin_audit_log: [{ data: null, error: { message: "denied" } }] })
    });
    await expect(logAdminAction({ adminEmail: "a", action: "x" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("swallows a client construction failure", async () => {
    holder.service = "throw";
    await expect(logAdminAction({ adminEmail: "a", action: "x" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("listAdminAuditLog", () => {
  it("returns rows newest first", async () => {
    holder.service = fakeClient({
      from: fakeFrom({ admin_audit_log: [{ data: [{ id: "a1", action: "comp_plan" }] }] })
    });
    const rows = await listAdminAuditLog();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("comp_plan");
  });

  it("treats a null payload as empty", async () => {
    holder.service = fakeClient({ from: fakeFrom({ admin_audit_log: [{ data: null }] }) });
    expect(await listAdminAuditLog(5)).toEqual([]);
  });
});

describe("auditActionLabel", () => {
  it("reads as words", () => {
    expect(auditActionLabel("force_refund_run")).toBe("force refund run");
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LinkedInConnect } from "@/components/LinkedInConnect";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  refresh.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

function fillForm() {
  fireEvent.change(screen.getByLabelText("LinkedIn email"), {
    target: { value: "me@example.com" }
  });
  fireEvent.change(screen.getByLabelText("LinkedIn password"), {
    target: { value: "secret-pw" }
  });
}

describe("LinkedInConnect (disconnected)", () => {
  it("requires email, password, and consent before connecting", () => {
    render(<LinkedInConnect initialEmail={null} />);
    const button = screen.getByText("Connect LinkedIn");
    expect(button).toBeDisabled();
    fillForm();
    expect(button).toBeDisabled(); // consent still unchecked
    fireEvent.click(screen.getByRole("checkbox"));
    expect(button).not.toBeDisabled();
  });

  it("posts the credentials with consent and refreshes on success", async () => {
    render(<LinkedInConnect initialEmail={null} />);
    fillForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Connect LinkedIn"));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/linkedin/account");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      email: "me@example.com",
      password: "secret-pw",
      consent: true
    });
  });

  it("shows an error and does not refresh when connecting fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<LinkedInConnect initialEmail={null} />);
    fillForm();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Connect LinkedIn"));

    await waitFor(() => expect(screen.getByText(/couldn't save/)).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("LinkedInConnect (connected)", () => {
  it("shows the connected email and disconnects", async () => {
    render(<LinkedInConnect initialEmail="me@example.com" />);
    expect(screen.getByText("me@example.com")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/linkedin/account");
    expect(init.method).toBe("DELETE");
  });

  it("shows an error when disconnecting fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<LinkedInConnect initialEmail="me@example.com" />);
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() => expect(screen.getByText(/couldn't disconnect/)).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });
});

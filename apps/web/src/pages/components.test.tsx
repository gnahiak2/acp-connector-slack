// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRecord } from "@slackboard/shared";
import { api } from "../api";
import { ApprovalPanel } from "../approvals";
import { StatusBadge } from "../components";
import { LoginPage } from "./Login";

vi.mock("../api", () => ({
  api: {
    resolveApproval: vi.fn(),
    login: vi.fn(),
  },
}));

const approval: ApprovalRecord = {
  id: "apr_1",
  sessionId: "ses_1",
  jobId: "job_1",
  kind: "acp_permission",
  toolCallId: "tc_1",
  title: "Write a file",
  details: { contentPreview: "diff README.md" },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
  status: "pending",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.mocked(api.resolveApproval).mockReset();
  vi.mocked(api.login).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("dashboard components", () => {
  it("renders status with a text label, not colour alone", () => {
    render(<StatusBadge status="awaiting_approval" />);
    expect(screen.getByText("awaiting approval")).toBeTruthy();
  });

  it("renders every exact approval option and records a decision", async () => {
    const onResolved = vi.fn();
    vi.mocked(api.resolveApproval).mockResolvedValue({
      approval: { ...approval, status: "resolved" },
    });
    render(<ApprovalPanel approvals={[approval]} onResolved={onResolved} />);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => expect(api.resolveApproval).toHaveBeenCalledWith("apr_1", "allow"));
    expect(onResolved).toHaveBeenCalled();
    expect(await screen.findByText("Decision recorded.")).toBeTruthy();
  });

  it("shows an approval error without losing the form state", async () => {
    vi.mocked(api.resolveApproval).mockRejectedValue(new Error("Approval has expired"));
    render(<ApprovalPanel approvals={[approval]} onResolved={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Approval has expired");
  });

  it("submits the login form and hands control back to the app", async () => {
    const onLogin = vi.fn();
    vi.mocked(api.login).mockResolvedValue({
      user: { name: "admin", role: "admin" },
      csrfToken: "csrf",
    });
    render(<LoginPage onLogin={onLogin} />);
    await userEvent.type(screen.getByLabelText(/Admin password/), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(api.login).toHaveBeenCalledWith("admin", "correct horse battery"),
    );
    expect(onLogin).toHaveBeenCalled();
  });
});

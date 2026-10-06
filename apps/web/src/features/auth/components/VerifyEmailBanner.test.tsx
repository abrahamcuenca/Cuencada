import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { AppProviders } from "../../../app/providers";
import { makeStore, type RootState } from "../../../app/store";
import { RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, okAccepted } from "../testing/contractHandlers";
import { RESEND_COOLDOWN_MS, resetResendCooldown, VERIFICATION_SENT_MESSAGE, VerifyEmailBanner } from "./VerifyEmailBanner";
import { createTestServer } from "../../../../test/msw";

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  resetResendCooldown();
  vi.useRealTimers();
});

function renderBanner(preloaded: Pick<RootState, "auth">): void {
  render(
    <AppProviders store={makeStore(preloaded)}>
      <VerifyEmailBanner />
    </AppProviders>
  );
}

describe("VerifyEmailBanner", () => {
  it("asks a logged-in user with an unverified email to verify it", () => {
    renderBanner(authenticatedState(makeUser({ emailVerified: false })));

    const banner = screen.getByRole("region", { name: "Verifica tu correo" });
    expect(banner).toHaveTextContent("prima@example.com");
  });

  it("renders nothing for verified users and anonymous visitors", () => {
    renderBanner(authenticatedState(makeUser({ emailVerified: true })));
    renderBanner(statusState("anonymous"));

    expect(screen.queryByRole("region", { name: "Verifica tu correo" })).not.toBeInTheDocument();
  });

  it("resends the verification email and confirms it", async () => {
    const requested = vi.fn();
    server.use(
      contractRoute("post", "/auth/email/verify-request", null, () => {
        requested();
        return okAccepted();
      })
    );
    renderBanner(authenticatedState(makeUser({ emailVerified: false })));

    await userEvent.click(screen.getByRole("button", { name: "Reenviar enlace" }));

    expect(await screen.findByText(VERIFICATION_SENT_MESSAGE)).toBeInTheDocument();
    expect(requested).toHaveBeenCalledTimes(1);
  });

  it("shows the rate-limit message when resending too often", async () => {
    server.use(contractRoute("post", "/auth/email/verify-request", null, () => apiError("RATE_LIMITED")));
    renderBanner(authenticatedState(makeUser({ emailVerified: false })));

    await userEvent.click(screen.getByRole("button", { name: "Reenviar enlace" }));

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("waits 60 seconds with a visible countdown before allowing another resend", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const requested = vi.fn();
    server.use(
      contractRoute("post", "/auth/email/verify-request", null, () => {
        requested();
        return okAccepted();
      })
    );
    renderBanner(authenticatedState(makeUser({ emailVerified: false })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: "Reenviar enlace" }));
    const cooling = await screen.findByRole("button", { name: /Reenviar en [01]:\d\d/ });
    expect(cooling).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("button", { name: /Reenviar en 0:[23]\d/ })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(RESEND_COOLDOWN_MS);
    });
    expect(screen.getByRole("button", { name: "Reenviar enlace" })).toBeEnabled();
    expect(requested).toHaveBeenCalledTimes(1);
  });
});

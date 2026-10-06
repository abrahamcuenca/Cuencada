import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { AppProviders } from "../../../app/providers";
import { makeStore, type RootState } from "../../../app/store";
import { RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, okAccepted } from "../testing/contractHandlers";
import { VERIFICATION_SENT_MESSAGE, VerifyEmailBanner } from "./VerifyEmailBanner";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

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
});

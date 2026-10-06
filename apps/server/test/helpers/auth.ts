import type { AuthTokenResponse } from "@cuencada/types";
import type { LightMyRequestResponse } from "fastify";
import type { App } from "../../src/app.js";
import type { Clock } from "../../src/lib/clock.js";
import type { SentMail } from "./fakes.js";

/** The dev/test refresh-cookie name (`COOKIE_SECURE=false`). */
export const TEST_REFRESH_COOKIE = "cuencada_rt";

/** Headers the guard requires on cookie routes (refresh, logout) in tests. */
export const CSRF_HEADERS = { origin: "http://localhost:5173", "x-cuencada-csrf": "1" } as const;

/** A cookie as parsed by light-my-request. */
export interface InjectedCookie {
  name: string;
  value: string;
  path?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

/**
 * The refresh cookie set by a response, if any.
 *
 * @param response - An `inject()` response.
 * @param name - Cookie name (defaults to the test name).
 */
export function refreshCookie(response: LightMyRequestResponse, name = TEST_REFRESH_COOKIE): InjectedCookie | undefined {
  // light-my-request types `cookies` loosely; every entry has these fields.
  const cookies = response.cookies as InjectedCookie[];
  return cookies.find((cookie) => cookie.name === name);
}

/** Request options that send `token` as the refresh cookie with valid CSRF headers. */
export function withRefreshCookie(token: string): { headers: Record<string, string>; cookies: Record<string, string> } {
  return { headers: { ...CSRF_HEADERS }, cookies: { [TEST_REFRESH_COOKIE]: token } };
}

/** Result of {@link loginFull}. */
export interface FullLogin {
  body: AuthTokenResponse;
  refreshToken: string;
  auth: { headers: { authorization: string } };
}

/**
 * Log in through the real route and return the body, the refresh token from
 * the cookie, and bearer headers.
 *
 * @param app - Test app.
 * @param user - Email and plaintext password.
 * @param headers - Extra request headers (e.g. `user-agent`).
 */
export async function loginFull(
  app: App,
  user: { email: string; password: string },
  headers: Record<string, string> = {}
): Promise<FullLogin> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers,
    payload: { email: user.email, password: user.password }
  });
  if (response.statusCode !== 200) throw new Error(`loginFull: ${response.statusCode} ${response.body}`);
  const cookie = refreshCookie(response);
  if (cookie === undefined) throw new Error("loginFull: no refresh cookie");
  const body = response.json<AuthTokenResponse>();
  return { body, refreshToken: cookie.value, auth: { headers: { authorization: `Bearer ${body.accessToken}` } } };
}

/**
 * The one-time token in an email's link (`…#t=<token>`), read from the text part.
 *
 * @param mail - A captured message.
 */
export function linkToken(mail: SentMail | undefined): string {
  const match = /#t=([A-Za-z0-9_-]+)/.exec(mail?.text ?? "");
  if (match?.[1] === undefined) throw new Error("linkToken: no #t= link in the email");
  return match[1];
}

/** A clock tests can move. */
export class TestClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Move forward by `ms`. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Milliseconds in a day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

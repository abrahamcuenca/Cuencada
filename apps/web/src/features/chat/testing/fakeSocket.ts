/**
 * A fake `WebSocket` for chat tests: no network. Tests drive the "server"
 * side with {@link FakeSocket.open}, {@link FakeSocket.receive} and
 * {@link FakeSocket.serverClose}, and read what the client sent.
 */
import type { WebSocketLike } from "../socket";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

function closeEvent(code: number, reason: string): CloseEvent {
  return new CloseEvent("close", { code, reason, wasClean: code === 1000 });
}

/** Records every socket the client opens. */
export class FakeSocket implements WebSocketLike {
  /** Every socket created since the last {@link FakeSocket.reset}. */
  static instances: FakeSocket[] = [];

  readonly url: string;
  readyState = CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** Raw frames the client sent. */
  readonly sent: string[] = [];
  /** Close code the client used, or `null` while it has not closed the socket. */
  closedByClient: number | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  /** Forgets every recorded socket. */
  static reset(): void {
    FakeSocket.instances = [];
  }

  /** @returns The most recent socket (throws if none). */
  static latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (socket === undefined) throw new Error("No FakeSocket was created");
    return socket;
  }

  /** @returns The ticket in the URL. */
  get ticket(): string | null {
    return new URL(this.url).searchParams.get("ticket");
  }

  /** Answer `ping` frames with a `pong`, like a healthy server. */
  autoPong = false;

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("FakeSocket is not open");
    this.sent.push(data);
    if (this.autoPong && data.includes('"type":"ping"')) this.receive({ type: "pong", ts: null });
  }

  close(code = 1000): void {
    this.readyState = CLOSED;
    this.closedByClient = code;
  }

  /** Server accepted the upgrade. */
  open(): void {
    this.readyState = OPEN;
    this.onopen?.(new Event("open"));
  }

  /**
   * Server sent a frame.
   *
   * @param data - An object (JSON-encoded) or a raw string.
   */
  receive(data: unknown): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.onmessage?.(new MessageEvent("message", { data: payload }));
  }

  /**
   * Server (or network) closed the socket.
   *
   * @param code - The close code.
   * @param reason - The close reason.
   */
  serverClose(code = 1006, reason = ""): void {
    this.readyState = CLOSED;
    this.onclose?.(closeEvent(code, reason));
  }

  /** @returns The client frames, parsed. */
  frames(): unknown[] {
    return this.sent.map((raw): unknown => JSON.parse(raw));
  }
}

/**
 * @param url - The socket URL.
 * @returns A new fake socket (use as the injected `createSocket`).
 */
export function createFakeSocket(url: string): FakeSocket {
  return new FakeSocket(url);
}

/**
 * @returns A random RFC 9562 version-4 uuid (the contract's `clientMessageId`).
 * Uses `crypto.randomUUID` where available (secure contexts) and builds one
 * from `crypto.getRandomValues` otherwise (e.g. the dev server over the LAN).
 */
export function createClientMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

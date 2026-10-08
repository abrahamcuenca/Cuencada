/**
 * Journey 8: two members on two phones exchange messages in real time over
 * the WebSocket (through the preview proxy), a delete shows the tombstone on
 * the other phone, and the unread badge appears on the Chat tab.
 */
import type { Page } from "@playwright/test";
import { CastRole, expect, journeyShot, login, test } from "./support/fixtures.js";

const ROOM = "Familia Cuenca";

async function openRoom(page: Page): Promise<void> {
  await page.goto("/chat");
  await page.getByRole("list", { name: "Salas" }).getByRole("link", { name: new RegExp(ROOM) }).click();
  await expect(page.getByRole("textbox", { name: "Mensaje" })).toBeEnabled();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Mensaje" }).fill(text);
  await page.getByRole("button", { name: "Enviar" }).click();
}

test.describe("chat", () => {
  test("8 · two members chat in real time; a delete shows a tombstone; the unread badge appears @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    const ana = cast(CastRole.Ana);
    const beto = cast(CastRole.Beto);
    const betoPhone = await newPhone();
    await login(page, ana);
    await login(betoPhone, beto);
    await openRoom(page);
    await openRoom(betoPhone);

    const hello = `¡Hola familia! (${project} · ${Date.now() % 100_000})`;
    await send(page, hello);
    await expect(betoPhone.getByRole("log").getByText(hello)).toBeVisible();

    const reply = `¡Hola, Ana! Ya vamos en camino (${project} · ${Date.now() % 100_000})`;
    await send(betoPhone, reply);
    await expect(page.getByRole("log").getByText(reply)).toBeVisible();
    await journeyShot(page, testInfo, "08-chat-conversation");

    // Ana deletes her message; Beto sees the tombstone in its place.
    // Message rows have no role of their own: take the innermost element holding both the text and its menu button.
    const options = page.getByRole("button", { name: "Opciones del mensaje de Tú" });
    const row = page.getByRole("log").locator("div").filter({ hasText: hello }).filter({ has: options }).last();
    await row.getByRole("button", { name: "Opciones del mensaje de Tú" }).click();
    await page.getByRole("dialog", { name: "Mensaje" }).getByRole("button", { name: "Eliminar" }).click();
    await page.getByRole("alertdialog", { name: "¿Eliminar este mensaje?" }).getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Mensaje eliminado.")).toBeVisible();
    await expect(betoPhone.getByRole("log").getByText(hello)).toHaveCount(0);
    await expect(betoPhone.getByRole("log").getByText("🚫 Mensaje eliminado").first()).toBeVisible();
    await journeyShot(betoPhone, testInfo, "08-chat-tombstone");

    // Beto leaves the room; a new message from Ana shows up as unread on his Chat tab.
    // Outside /chat the badge comes from the rooms list (fetched on load, then polled every 2 min).
    await betoPhone.goto("/");
    await expect(betoPhone.getByRole("button", { name: /^Mi cuenta/ })).toBeVisible();
    const later = `¿Ya llegaron? (${project} · ${Date.now() % 100_000})`;
    await send(page, later);
    await expect(page.getByRole("log").getByText(later)).toBeVisible();
    await betoPhone.reload();
    await expect(betoPhone.getByRole("link", { name: /Chat.*sin leer/ }).first()).toBeVisible();
    await journeyShot(betoPhone, testInfo, "08-chat-unread-badge");

    await betoPhone.goto("/chat");
    const roomLink = betoPhone.getByRole("list", { name: "Salas" }).getByRole("link", { name: new RegExp(ROOM) });
    await expect(roomLink).toContainText(/\d/);
  });
});

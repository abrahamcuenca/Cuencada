import type { ChatSender } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import { makeMessage, makeRooms, ME, PEOPLE, ROOMS } from "../testing/fixtures";
import { applyDeletedToRooms, applyMessageToRooms, applyReadToRooms, mergeRoomLists, roomsFromResponse, totalUnread } from "./rooms";
import {
  applyDeletedMessage,
  applyIncomingMessage,
  appendPendingMessage,
  type ChatThread,
  firstUnreadMessageId,
  lastServerMessage,
  mergeLatestPage,
  prependOlderPage,
  removeLocalMessage,
  setLocalStatus,
  type ThreadMessage,
  threadFromPage
} from "./thread";

const CLIENT_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function thread(...numbers: number[]): ChatThread {
  return threadFromPage({ messages: numbers.map((n) => makeMessage(n)), nextBefore: "c:older" });
}

function pending(body = "Hola", clientMessageId = CLIENT_ID): ThreadMessage {
  return {
    id: clientMessageId,
    roomId: ROOMS.familia,
    sender: ME,
    body,
    createdAt: "2026-09-14T16:00:00.000Z",
    deletedAt: null,
    clientMessageId,
    status: "pending"
  };
}

const ids = (value: ChatThread): string[] => value.messages.map((message) => message.id);

describe("applyIncomingMessage", () => {
  it("appends a new message from someone else in time order", () => {
    const next = applyIncomingMessage(thread(1, 2), makeMessage(3), null);
    expect(ids(next)).toEqual([makeMessage(1).id, makeMessage(2).id, makeMessage(3).id]);
    expect(next.nextBefore).toBe("c:older");
  });

  it("replaces my pending copy with the echo instead of duplicating it", () => {
    const withPending = appendPendingMessage(thread(1), pending());
    const echo = makeMessage(9, { sender: ME, body: "Hola" });
    const next = applyIncomingMessage(withPending, echo, CLIENT_ID);
    expect(ids(next)).toEqual([makeMessage(1).id, echo.id]);
    expect(next.messages[1]).toMatchObject({ status: "sent", clientMessageId: CLIENT_ID });
  });

  it("ignores a second copy of the same message (echo after a refetch)", () => {
    const once = applyIncomingMessage(thread(1), makeMessage(2), null);
    const twice = applyIncomingMessage(once, makeMessage(2), null);
    expect(ids(twice)).toHaveLength(2);
  });

  it("keeps pending messages at the end when an older message arrives", () => {
    const withPending = appendPendingMessage(thread(1, 3), pending());
    const next = applyIncomingMessage(withPending, makeMessage(2), null);
    expect(ids(next)).toEqual([makeMessage(1).id, makeMessage(2).id, makeMessage(3).id, CLIENT_ID]);
  });

  it("never resurrects a tombstone with a stale copy", () => {
    const deleted = applyDeletedMessage(thread(1), makeMessage(1).id, "2026-09-14T17:00:00.000Z");
    const next = applyIncomingMessage(deleted, makeMessage(1), null);
    expect(next.messages[0]).toMatchObject({ body: "", deletedAt: "2026-09-14T17:00:00.000Z" });
  });
});

describe("applyDeletedMessage", () => {
  it("turns the message into a tombstone and leaves the rest alone", () => {
    const next = applyDeletedMessage(thread(1, 2), makeMessage(2).id, "2026-09-14T17:00:00.000Z");
    expect(next.messages[1]).toMatchObject({ body: "", deletedAt: "2026-09-14T17:00:00.000Z" });
    expect(next.messages[0]?.body).toBe("Mensaje 1");
  });

  it("returns the same thread when the message is not cached", () => {
    const current = thread(1);
    expect(applyDeletedMessage(current, makeMessage(7).id)).toBe(current);
  });
});

describe("mergeLatestPage", () => {
  it("keeps older pages and pending messages when the new page overlaps the cache", () => {
    const current = appendPendingMessage(prependOlderPage(thread(3, 4), { messages: [makeMessage(1), makeMessage(2)], nextBefore: null }), pending());
    const latest = threadFromPage({ messages: [makeMessage(4), makeMessage(5)], nextBefore: "c:3" });
    const merged = mergeLatestPage(current, latest);
    expect(ids(merged)).toEqual([1, 2, 3, 4, 5].map((n) => makeMessage(n).id).concat(CLIENT_ID));
    expect(merged.nextBefore).toBeNull();
  });

  it("restarts from the new page when more than a page was missed (no silent hole)", () => {
    const current = thread(1, 2);
    const latest = threadFromPage({ messages: [makeMessage(60), makeMessage(61)], nextBefore: "c:59" });
    const merged = mergeLatestPage(appendPendingMessage(current, pending()), latest);
    expect(ids(merged)).toEqual([makeMessage(60).id, makeMessage(61).id, CLIENT_ID]);
    expect(merged.nextBefore).toBe("c:59");
  });
});

describe("prependOlderPage", () => {
  it("adds older messages in front, skips duplicates and moves the cursor", () => {
    const next = prependOlderPage(thread(3, 4), { messages: [makeMessage(2), makeMessage(3)], nextBefore: null });
    expect(ids(next)).toEqual([2, 3, 4].map((n) => makeMessage(n).id));
    expect(next.nextBefore).toBeNull();
  });
});

describe("local message status", () => {
  it("marks a pending message failed, back to pending, and discards it", () => {
    const base = appendPendingMessage(thread(1), pending());
    const failed = setLocalStatus(base, CLIENT_ID, "failed");
    expect(failed.messages[1]?.status).toBe("failed");
    expect(setLocalStatus(failed, CLIENT_ID, "pending").messages[1]?.status).toBe("pending");
    expect(ids(removeLocalMessage(failed, CLIENT_ID))).toEqual([makeMessage(1).id]);
    expect(lastServerMessage(failed)?.id).toBe(makeMessage(1).id);
  });
});

describe("room list updates", () => {
  const rooms = roomsFromResponse(makeRooms());

  it("sorts the global room first, then editions newest first", () => {
    // Global pinned first, then the most recent activity (2025 had messages; 2026 none yet).
    expect(rooms.map((room) => room.title)).toEqual(["Toda la familia", "Cuencada 2025", "Cuencada 2026"]);
    expect(totalUnread(rooms)).toBe(3);
    expect(totalUnread(undefined)).toBe(0);
  });

  it("counts a message from someone else as unread and records the preview", () => {
    const message = makeMessage(10, { roomId: ROOMS.y2026, sender: PEOPLE.tomas, createdAt: "2026-10-01T10:00:00.000Z" });
    const { rooms: next, found } = applyMessageToRooms(rooms, message, { meId: ME.userId, viewingRoomId: null });
    const room = next.find((entry) => entry.id === ROOMS.y2026);
    expect(found).toBe(true);
    expect(room).toMatchObject({ unreadCount: 1, lastMessageAt: message.createdAt, preview: { body: "Mensaje 10", senderName: "Tomás Herrera Vidal" } });
    // The room with the newest activity moves up, after the pinned global room.
    expect(next.map((entry) => entry.title)).toEqual(["Toda la familia", "Cuencada 2026", "Cuencada 2025"]);
  });

  it("does not count my own messages, the room I am reading, or the same message twice", () => {
    const later = (n: number, sender: ChatSender = PEOPLE.lucia): ReturnType<typeof makeMessage> =>
      makeMessage(n, { sender, createdAt: `2026-10-01T10:0${n % 10}:00.000Z` });
    const mine = applyMessageToRooms(rooms, later(11, ME), { meId: ME.userId, viewingRoomId: null }).rooms;
    expect(mine.find((room) => room.id === ROOMS.familia)?.unreadCount).toBe(3);
    const viewing = applyMessageToRooms(rooms, later(12), { meId: ME.userId, viewingRoomId: ROOMS.familia }).rooms;
    expect(viewing.find((room) => room.id === ROOMS.familia)?.unreadCount).toBe(3);
    const once = applyMessageToRooms(rooms, later(13), { meId: ME.userId, viewingRoomId: null }).rooms;
    const twice = applyMessageToRooms(once, later(13), { meId: ME.userId, viewingRoomId: null }).rooms;
    expect(twice.find((room) => room.id === ROOMS.familia)?.unreadCount).toBe(4);
  });

  it("reports unknown rooms so the list can be refetched", () => {
    const message = makeMessage(1, { roomId: "99999999-0000-4000-8000-000000000001" });
    expect(applyMessageToRooms(rooms, message, { meId: null, viewingRoomId: null }).found).toBe(false);
  });

  it("clears the count on read and blanks a deleted preview", () => {
    const message = makeMessage(20, { createdAt: "2026-10-01T10:00:00.000Z" });
    const withPreview = applyMessageToRooms(rooms, message, { meId: ME.userId, viewingRoomId: null }).rooms;
    const read = applyReadToRooms(withPreview, ROOMS.familia, message.id);
    expect(read.find((room) => room.id === ROOMS.familia)).toMatchObject({ unreadCount: 0, lastReadMessageId: message.id });
    const deleted = applyDeletedToRooms(read, ROOMS.familia, message.id);
    expect(deleted.find((room) => room.id === ROOMS.familia)?.preview).toMatchObject({ deleted: true, body: "" });
  });

  it("uses the server preview, but keeps a newer one learnt from a frame across a refetch", () => {
    expect(rooms.find((room) => room.id === ROOMS.familia)?.preview).toMatchObject({ body: "Mensaje 5", senderName: "Lucía Ramírez Solís", senderId: PEOPLE.lucia.userId });
    const message = makeMessage(21, { createdAt: "2026-10-01T10:00:00.000Z" });
    const withPreview = applyMessageToRooms(rooms, message, { meId: ME.userId, viewingRoomId: null }).rooms;
    const refetched = mergeRoomLists(withPreview, roomsFromResponse(makeRooms()));
    expect(refetched.find((room) => room.id === ROOMS.familia)?.preview?.messageId).toBe(message.id);
  });

  it("caps the unread count like the server (999)", () => {
    const capped = roomsFromResponse(makeRooms({ familia: { unreadCount: 999 } }));
    const message = makeMessage(30, { createdAt: "2026-10-01T10:00:00.000Z" });
    const next = applyMessageToRooms(capped, message, { meId: ME.userId, viewingRoomId: null }).rooms;
    expect(next.find((room) => room.id === ROOMS.familia)?.unreadCount).toBe(999);
  });
});

describe("firstUnreadMessageId", () => {
  const messages = thread(1, 2, 3, 4).messages;

  it("starts after lastReadMessageId", () => {
    expect(firstUnreadMessageId(messages, { unreadCount: 2, lastReadMessageId: makeMessage(2).id }, ME.userId)).toBe(makeMessage(3).id);
  });

  it("counts back unreadCount messages from others when the last read one is not loaded", () => {
    expect(firstUnreadMessageId(messages, { unreadCount: 3, lastReadMessageId: null }, ME.userId)).toBe(makeMessage(2).id);
  });

  it("is null with nothing unread", () => {
    expect(firstUnreadMessageId(messages, { unreadCount: 0, lastReadMessageId: null }, ME.userId)).toBeNull();
    expect(firstUnreadMessageId(messages, undefined, ME.userId)).toBeNull();
  });
});

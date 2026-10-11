/**
 * Unit tests of the hub's per-room audiences (WP-5.3) [SEC]: `fanOutRoom`
 * filters by the room audience, a refresh sends `room_removed` to users who
 * lost access, and a fan-out whose audience load raced a refresh reloads
 * instead of using the stale set.
 */
import type { WsServerMessage } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import type { Database } from "../../db/client.js";
import { type ChatConnection, ChatHub } from "./hub.js";
import type { RoomAudience } from "./repository.js";

const ROOM = "room-1";

function users(...ids: string[]): RoomAudience {
  return { kind: "users", userIds: new Set(ids) };
}

function hubWith(loadAudience: (roomId: string) => Promise<RoomAudience>): ChatHub {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as ConstructorParameters<
    typeof ChatHub
  >[0]["log"]; // only the levels the hub calls
  return new ChatHub({ db: {} as Database, clock: { now: () => new Date() }, log, loadAudience }); // db unused with a loader
}

function connect(hub: ChatHub, userId: string): { frames: WsServerMessage[] } {
  const frames: WsServerMessage[] = [];
  const connection: ChatConnection = {
    id: hub.allocateId(),
    principal: { userId, sessionId: `s-${userId}`, displayName: userId, role: "member", listedInDirectory: false },
    alive: true,
    send: (frame) => frames.push(frame),
    close: () => undefined,
    ping: () => undefined,
    terminate: () => undefined
  };
  hub.add(connection);
  return { frames };
}

const message = (): WsServerMessage => ({ type: "typing", roomId: ROOM, userId: "x", displayName: "X" });

describe("ChatHub room audiences", () => {
  it("delivers room frames only to the audience and room_removed to users who lost access", async () => {
    let audience = users("ana", "bea");
    const hub = hubWith(async () => audience);
    const ana = connect(hub, "ana");
    const bea = connect(hub, "bea");
    const eve = connect(hub, "eve");
    await hub.fanOutRoom(ROOM, message);
    const types = (frames: WsServerMessage[]): string[] => frames.filter((f) => f.type !== "presence").map((f) => f.type);
    expect([types(ana.frames), types(bea.frames), types(eve.frames)]).toEqual([["typing"], ["typing"], []]);

    audience = users("ana");
    await hub.refreshRoomAudience(ROOM);
    await hub.fanOutRoom(ROOM, message);
    expect(types(bea.frames)).toEqual(["typing", "room_removed"]);
    expect(types(ana.frames)).toEqual(["typing", "typing"]);
    expect(types(eve.frames)).toEqual([]);
  });

  it("reloads an audience whose load raced a refresh (never sends with the stale set)", async () => {
    let current = users("ana", "bea");
    let releaseSlowLoad: () => void = () => undefined;
    let slow = true;
    const hub = hubWith(async () => {
      const snapshot = current;
      if (slow) {
        slow = false;
        // The first load reads the pre-change set, then stalls past the refresh.
        await new Promise<void>((resolve) => {
          releaseSlowLoad = resolve;
        });
      }
      return snapshot;
    });
    const bea = connect(hub, "bea");
    const pending = hub.fanOutRoom(ROOM, message);
    await Promise.resolve();
    current = users("ana");
    await hub.refreshRoomAudience(ROOM, new Set(["ana", "bea"]));
    releaseSlowLoad();
    await pending;
    expect(bea.frames.filter((f) => f.type !== "presence").map((f) => f.type)).toEqual(["room_removed"]);
  });

  it("re-checks the generation after the audience await: a refresh landing before the sends reloads the set (PR #54 L2)", async () => {
    let current = users("ana", "bea");
    const hub = hubWith(async () => current);
    const ana = connect(hub, "ana");
    const bea = connect(hub, "bea");
    await hub.fanOutRoom(ROOM, message); // warm cache: { ana, bea }
    let landed = false;
    hub.hooks.afterAudience = async () => {
      if (landed) return;
      landed = true;
      // Bea is removed while this fan-out holds the old set.
      current = users("ana");
      await hub.refreshRoomAudience(ROOM);
    };
    await hub.fanOutRoom(ROOM, message);
    const types = (frames: WsServerMessage[]): string[] => frames.filter((f) => f.type !== "presence").map((f) => f.type);
    expect(landed).toBe(true);
    expect(types(bea.frames)).toEqual(["typing", "room_removed"]);
    expect(types(ana.frames)).toEqual(["typing", "typing"]);
  });

  it("removeRoom tells every previous reader and forgets the room", async () => {
    const hub = hubWith(async () => users("ana"));
    const ana = connect(hub, "ana");
    await hub.fanOutRoom(ROOM, message);
    await hub.removeRoom(ROOM, new Set(["ana"]));
    expect(ana.frames.filter((f) => f.type !== "presence").map((f) => f.type)).toEqual(["typing", "room_removed"]);
  });
});

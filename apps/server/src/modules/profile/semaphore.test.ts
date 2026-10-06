import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore.js";

/** A promise plus its resolver, to hold a task open from the test. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Semaphore", () => {
  it("throws RangeError when the limit is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) expect(() => new Semaphore(limit)).toThrow(RangeError);
  });

  it("runs at most `limit` tasks at once and starts waiters in FIFO order", async () => {
    const semaphore = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      })
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect([semaphore.active, semaphore.waiting]).toEqual([2, 2]);

    gates[1]?.resolve();
    await runs[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    expect([semaphore.active, semaphore.waiting]).toEqual([2, 1]);

    for (const gate of gates) gate.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect([semaphore.active, semaphore.waiting]).toEqual([0, 0]);
  });

  it("releases the slot when a task rejects", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await semaphore.run(() => Promise.resolve("next"))).toBe("next");
    expect(semaphore.active).toBe(0);
  });
});

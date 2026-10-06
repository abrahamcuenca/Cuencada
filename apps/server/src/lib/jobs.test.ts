import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createJobQueue } from "./jobs.js";

function fakeLogger(): FastifyBaseLogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const log = {
    level: "info",
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: () => log
  };
  return log as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }; // minimal pino-shaped stub
}

describe("createJobQueue", () => {
  it("runs jobs one at a time in FIFO order", async () => {
    const queue = createJobQueue(fakeLogger());
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string) => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${name}`);
      running -= 1;
    };

    queue.enqueue("a", job("a"));
    queue.enqueue("b", job("b"));
    queue.enqueue("c", job("c"));
    await queue.onIdle();

    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(maxRunning).toBe(1);
  });

  it("logs a failing job and keeps processing the next ones", async () => {
    const log = fakeLogger();
    const queue = createJobQueue(log);
    const done = vi.fn();

    queue.enqueue("fails", async () => {
      throw new Error("boom");
    });
    queue.enqueue("works", async () => {
      done();
    });
    await queue.onIdle();

    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ job: "fails" }), "job failed");
    expect(done).toHaveBeenCalledOnce();
  });

  it("resolves onIdle immediately when nothing is queued and restarts after idling", async () => {
    const queue = createJobQueue(fakeLogger());
    const done = vi.fn();

    await queue.onIdle();
    queue.enqueue("later", async () => done());
    await queue.onIdle();

    expect(done).toHaveBeenCalledOnce();
  });

  it("drops pending jobs, aborts the running one and refuses new ones after close", async () => {
    const log = fakeLogger();
    const queue = createJobQueue(log);
    const second = vi.fn();
    let aborted = false;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    queue.enqueue("long", async (signal) => {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 10));
      aborted = signal.aborted;
    });
    queue.enqueue("second", async () => second());
    await started;
    await queue.close();

    expect(aborted).toBe(true);
    expect(second).not.toHaveBeenCalled();
    expect(queue.enqueue("after", async () => second())).toBe(false);
    expect(queue.pending).toBe(0);
  });
});

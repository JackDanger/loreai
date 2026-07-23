import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  sigmoidBackoffMs,
  upstreamFetchWithRetry,
} from "../src/upstream-retry";

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return { server, url: `http://localhost:${port}` };
}

const ENV_KEYS = [
  "LORE_UPSTREAM_RETRY_MAX_ATTEMPTS",
  "LORE_UPSTREAM_RETRY_ATTEMPT_TIMEOUT_MS",
  "LORE_UPSTREAM_RETRY_MIN_DELAY_MS",
  "LORE_UPSTREAM_RETRY_MAX_DELAY_MS",
  "LORE_UPSTREAM_RETRY_RAMP_SCALE",
] as const;

describe("sigmoidBackoffMs", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  });

  test("starts near minDelayMs and plateaus at maxDelayMs, never exceeding it", () => {
    const opts = { minDelayMs: 500, maxDelayMs: 30_000, rampScale: 3 };
    const first = sigmoidBackoffMs(1, opts);
    const mid = sigmoidBackoffMs(3, opts);
    const late = sigmoidBackoffMs(20, opts);
    const veryLate = sigmoidBackoffMs(1000, opts);

    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThan(mid);
    expect(mid).toBeLessThan(late);
    // Plateaus: attempt 1000 is not meaningfully bigger than attempt 20 —
    // the defining difference from exponential backoff (which would keep
    // growing without bound).
    expect(veryLate).toBeLessThanOrEqual(30_000);
    expect(veryLate - late).toBeLessThan(50);
  });

  test("is monotonically non-decreasing", () => {
    const opts = { minDelayMs: 100, maxDelayMs: 10_000, rampScale: 4 };
    let prev = 0;
    for (let attempt = 1; attempt <= 50; attempt++) {
      const delay = sigmoidBackoffMs(attempt, opts);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });
});

describe("upstreamFetchWithRetry", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const current = server;
    if (current) await new Promise((r) => current.close(r));
    server = undefined;
    vi.restoreAllMocks();
  });

  test("returns immediately on a normal 200 — no retry, no delay", async () => {
    let hits = 0;
    const { server: s, url } = await listen((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server = s;

    const res = await upstreamFetchWithRetry(url, { method: "POST" });
    expect(res.status).toBe(200);
    expect(hits).toBe(1);
  });

  test("retries on 502/503/504 and eventually succeeds", async () => {
    const codes = [502, 503, 504];
    let hits = 0;
    const { server: s, url } = await listen((_req, res) => {
      hits++;
      if (hits <= codes.length) {
        res.writeHead(codes[hits - 1]);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("recovered");
    });
    server = s;

    const res = await upstreamFetchWithRetry(
      url,
      {},
      { minDelayMs: 1, maxDelayMs: 5, rampScale: 1 },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("recovered");
    expect(hits).toBe(4);
  });

  test("does not retry a real 400 — hands it back immediately", async () => {
    let hits = 0;
    const { server: s, url } = await listen((_req, res) => {
      hits++;
      res.writeHead(400);
      res.end("bad request");
    });
    server = s;

    const res = await upstreamFetchWithRetry(
      url,
      {},
      { minDelayMs: 1, maxDelayMs: 5 },
    );
    expect(res.status).toBe(400);
    expect(hits).toBe(1);
  });

  test("retries a connection-refused error (nothing listening) and gives up after maxAttempts", async () => {
    // Port with nothing listening — every attempt throws ECONNREFUSED.
    const deadUrl = "http://127.0.0.1:1";
    await expect(
      upstreamFetchWithRetry(
        deadUrl,
        {},
        { maxAttempts: 3, minDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow();
  });

  test("retries when an attempt exceeds attemptTimeoutMs (hung connection)", async () => {
    let hits = 0;
    const { server: s, url } = await listen((_req, res) => {
      hits++;
      if (hits === 1) {
        // Never respond — simulates llama-swap hanging while its backend
        // is busy/unavailable. Deliberately don't call res.end().
        return;
      }
      res.writeHead(200);
      res.end("ok after hang");
    });
    server = s;

    const res = await upstreamFetchWithRetry(
      url,
      {},
      { attemptTimeoutMs: 100, minDelayMs: 1, maxDelayMs: 5 },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok after hang");
    expect(hits).toBe(2);
  });

  test("calls onRetry with attempt number, delay, and reason on each retry", async () => {
    let hits = 0;
    const { server: s, url } = await listen((_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("ok");
    });
    server = s;

    const calls: Array<[number, number, string]> = [];
    await upstreamFetchWithRetry(
      url,
      {},
      {
        minDelayMs: 1,
        maxDelayMs: 5,
        onRetry: (attempt, delayMs, reason) =>
          calls.push([attempt, delayMs, reason]),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(1);
    expect(calls[0][2]).toContain("503");
  });

  test("a caller-supplied AbortSignal that fires is never retried", async () => {
    const { server: s, url } = await listen((_req, res) => {
      // Never respond.
      void res;
    });
    server = s;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    await expect(
      upstreamFetchWithRetry(
        url,
        { signal: controller.signal },
        { attemptTimeoutMs: 5_000, minDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toThrow();
  });

  test("env vars override the hardcoded defaults", async () => {
    process.env.LORE_UPSTREAM_RETRY_MAX_ATTEMPTS = "2";
    let hits = 0;
    const { server: s, url } = await listen((_req, res) => {
      hits++;
      res.writeHead(503);
      res.end();
    });
    server = s;

    await expect(
      upstreamFetchWithRetry(url, {}, { minDelayMs: 1, maxDelayMs: 5 }),
    ).resolves.toMatchObject({ status: 503 });
    expect(hits).toBe(2); // maxAttempts=2 from env, explicit opts didn't override it
    delete process.env.LORE_UPSTREAM_RETRY_MAX_ATTEMPTS;
  });
});

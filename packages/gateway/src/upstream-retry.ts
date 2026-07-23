/**
 * Retry wrapper around {@link upstreamFetch} for transient upstream failures
 * (connection refused/reset, no response within a bounded per-attempt
 * window, or a 502/503/504 from a proxy in front of the real backend —
 * exactly what llama-swap returns when its backend hasn't answered within
 * ITS OWN internal timeout during a model swap or heavy concurrent load).
 *
 * `upstreamFetch` itself deliberately disables timeouts (bodyTimeout:0,
 * headersTimeout:0 — see fetch.ts) so a slow-but-progressing generation is
 * never killed mid-stream. This module does not change that: the per-attempt
 * timeout here only bounds how long we wait for a response to START arriving
 * (headers/status) before giving up on THAT attempt and retrying — once a
 * response is obtained, its (still timeout-free) body stream is returned
 * as-is, so a legitimately slow multi-minute generation is untouched.
 *
 * Backoff is sigmoidal (tanh), not exponential: it ramps up over the first
 * few attempts and then plateaus at `maxDelayMs` instead of growing
 * unbounded, so a prolonged outage still gets retried at a steady, bounded
 * cadence rather than eventually waiting hours between attempts.
 */
import { log } from "@loreai/core";
import { upstreamFetch } from "./fetch";

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface RetryOptions {
  /** Total attempts including the first. Default: 40. */
  maxAttempts?: number;
  /** How long to wait for a response to START (headers/status) before
   *  aborting that attempt and retrying. Does not bound body/stream reading
   *  once a response is obtained. Default: 90_000 (90s). */
  attemptTimeoutMs?: number;
  /** Backoff floor for attempt 2+. Default: 500ms. */
  minDelayMs?: number;
  /** Backoff ceiling the sigmoid plateaus at. Default: 30_000 (30s). */
  maxDelayMs?: number;
  /** Controls how quickly the sigmoid ramps from minDelayMs to maxDelayMs —
   *  smaller is faster. Default: 3. */
  rampScale?: number;
  /** Called before each retry (not the first attempt) with the 0-indexed
   *  attempt number about to run, the delay about to be waited, and why the
   *  previous attempt failed. Useful for logging/metrics; never awaited. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const HARDCODED_DEFAULTS: Required<Omit<RetryOptions, "onRetry">> = {
  maxAttempts: 40,
  attemptTimeoutMs: 90_000,
  minDelayMs: 500,
  maxDelayMs: 30_000,
  rampScale: 3,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Env-var-tunable defaults, resolved fresh on each call (not cached — these
 * are cheap reads and tests/operators may change them at runtime). Explicit
 * per-call `opts` always win over these; these only fill gaps.
 *
 *   LORE_UPSTREAM_RETRY_MAX_ATTEMPTS
 *   LORE_UPSTREAM_RETRY_ATTEMPT_TIMEOUT_MS
 *   LORE_UPSTREAM_RETRY_MIN_DELAY_MS
 *   LORE_UPSTREAM_RETRY_MAX_DELAY_MS
 *   LORE_UPSTREAM_RETRY_RAMP_SCALE
 */
function resolveDefaults(): Required<Omit<RetryOptions, "onRetry">> {
  return {
    maxAttempts: envInt(
      "LORE_UPSTREAM_RETRY_MAX_ATTEMPTS",
      HARDCODED_DEFAULTS.maxAttempts,
    ),
    attemptTimeoutMs: envInt(
      "LORE_UPSTREAM_RETRY_ATTEMPT_TIMEOUT_MS",
      HARDCODED_DEFAULTS.attemptTimeoutMs,
    ),
    minDelayMs: envInt(
      "LORE_UPSTREAM_RETRY_MIN_DELAY_MS",
      HARDCODED_DEFAULTS.minDelayMs,
    ),
    maxDelayMs: envInt(
      "LORE_UPSTREAM_RETRY_MAX_DELAY_MS",
      HARDCODED_DEFAULTS.maxDelayMs,
    ),
    rampScale: envInt(
      "LORE_UPSTREAM_RETRY_RAMP_SCALE",
      HARDCODED_DEFAULTS.rampScale,
    ),
  };
}

/**
 * Sigmoidal (tanh) backoff delay for the given 1-indexed retry attempt
 * (attempt 1 = the first RETRY, i.e. after the first failure).
 *
 * Unlike exponential backoff (`base ** attempt`, unbounded), this ramps from
 * `minDelayMs` toward `maxDelayMs` and then stays there — a prolonged outage
 * gets retried at a steady ~maxDelayMs cadence forever, never waiting longer
 * and longer between attempts.
 */
export function sigmoidBackoffMs(
  attempt: number,
  opts: Pick<RetryOptions, "minDelayMs" | "maxDelayMs" | "rampScale"> = {},
): number {
  const defaults = resolveDefaults();
  const minDelayMs = opts.minDelayMs ?? defaults.minDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? defaults.maxDelayMs;
  const rampScale = opts.rampScale ?? defaults.rampScale;
  const shaped = Math.tanh(Math.max(0, attempt) / rampScale);
  return Math.round(minDelayMs + (maxDelayMs - minDelayMs) * shaped);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `upstreamFetch` with retry-with-sigmoidal-backoff for transient failures:
 * thrown network errors (connection refused/reset, DNS failure), a per-
 * attempt timeout waiting for a response to start, or a 502/503/504 status.
 * Any other status (2xx, 4xx, or a 5xx not in the retry set) is returned
 * immediately — those are real answers, not transient unavailability.
 */
export async function upstreamFetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: RetryOptions = {},
): Promise<Response> {
  const defaults = resolveDefaults();
  const maxAttempts = opts.maxAttempts ?? defaults.maxAttempts;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? defaults.attemptTimeoutMs;

  let lastReason = "unknown error";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delayMs = sigmoidBackoffMs(attempt, opts);
      opts.onRetry?.(attempt, delayMs, lastReason);
      log.warn(
        `upstream retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms (${lastReason})`,
      );
      await sleep(delayMs);
    }

    const controller = new AbortController();
    // If the caller already passed a signal, respect it too — abort this
    // attempt when either the per-attempt timeout OR the caller's own
    // signal fires.
    const callerSignal = init?.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", onCallerAbort);
    }
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);

    try {
      const response = await upstreamFetch(input, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);

      if (!RETRYABLE_STATUS.has(response.status)) return response;
      if (attempt === maxAttempts - 1) return response; // out of attempts — hand back the last error response
      lastReason = `HTTP ${response.status}`;
    } catch (e) {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (callerSignal?.aborted) throw e; // caller cancelled — never retry that
      if (attempt === maxAttempts - 1) throw e;
      lastReason = e instanceof Error ? e.message : String(e);
    }
  }
  // Unreachable (loop always returns/throws on the last attempt), but keeps
  // the return type honest without a non-null assertion.
  throw new Error(`upstreamFetchWithRetry: exhausted ${maxAttempts} attempts`);
}

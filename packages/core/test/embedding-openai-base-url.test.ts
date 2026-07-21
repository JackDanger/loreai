import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, load } from "../src/config";
import {
  embed,
  isAvailable,
  _resetLocalProviderProbe,
  _saveAndClearProvider,
  _restoreProvider,
} from "../src/embedding";

// Covers the `search.embeddings.baseUrl` config field: the "openai" provider
// must be redirectable to a self-hosted OpenAI-compatible embeddings server
// (llama.cpp / llama-swap / vLLM / TEI) instead of the real OpenAI API.
describe("OpenAI provider baseUrl override", () => {
  let savedOpenAIKey: string | undefined;
  let savedBaseUrlEnv: string | undefined;
  let providerToken: unknown;

  beforeEach(async () => {
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    savedBaseUrlEnv = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "nope"; // self-hosted servers don't check it
    await load(process.cwd());
    (
      config().search.embeddings as {
        provider: string;
        baseUrl?: string;
      }
    ).provider = "openai";
    _resetLocalProviderProbe();
    providerToken = _saveAndClearProvider();
  });

  afterEach(() => {
    if (savedOpenAIKey !== undefined)
      process.env.OPENAI_API_KEY = savedOpenAIKey;
    else delete process.env.OPENAI_API_KEY;
    if (savedBaseUrlEnv !== undefined)
      process.env.OPENAI_BASE_URL = savedBaseUrlEnv;
    else delete process.env.OPENAI_BASE_URL;
    (
      config().search.embeddings as { provider: string; baseUrl?: string }
    ).provider = "local";
    (
      config().search.embeddings as { provider: string; baseUrl?: string }
    ).baseUrl = undefined;
    _restoreProvider(providerToken);
    vi.restoreAllMocks();
  });

  it("hits the real OpenAI endpoint when baseUrl is not set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), {
        status: 200,
      }),
    );

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.anything(),
    );
  });

  it("routes to a self-hosted server when baseUrl is set in config", async () => {
    (
      config().search.embeddings as { provider: string; baseUrl?: string }
    ).baseUrl = "http://10.0.2.240:8080/v1";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), {
        status: 200,
      }),
    );

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://10.0.2.240:8080/v1/embeddings",
      expect.anything(),
    );
  });

  it("strips a trailing slash from a configured baseUrl", async () => {
    (
      config().search.embeddings as { provider: string; baseUrl?: string }
    ).baseUrl = "http://10.0.2.240:8080/v1/";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), {
        status: 200,
      }),
    );

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://10.0.2.240:8080/v1/embeddings",
      expect.anything(),
    );
  });

  it("falls back to OPENAI_BASE_URL env var when config doesn't set baseUrl", async () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), {
        status: 200,
      }),
    );

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:11434/v1/embeddings",
      expect.anything(),
    );
  });

  it("prefers config baseUrl over the OPENAI_BASE_URL env var", async () => {
    process.env.OPENAI_BASE_URL = "http://env-should-lose:11434/v1";
    (
      config().search.embeddings as { provider: string; baseUrl?: string }
    ).baseUrl = "http://10.0.2.240:8080/v1";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), {
        status: 200,
      }),
    );

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://10.0.2.240:8080/v1/embeddings",
      expect.anything(),
    );
  });

  it("isAvailable() is true for the openai provider regardless of baseUrl", () => {
    (
      config().search.embeddings as { provider: string; baseUrl?: string }
    ).baseUrl = "http://10.0.2.240:8080/v1";
    expect(isAvailable()).toBe(true);
  });
});

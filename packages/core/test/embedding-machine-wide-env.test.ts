import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, load } from "../src/config";
import {
  embed,
  embeddingStatus,
  isAvailable,
  _resetLocalProviderProbe,
  _saveAndClearProvider,
  _restoreProvider,
} from "../src/embedding";

type EmbeddingsCfg = { provider: string; model: string; dimensions: number };

// Covers LORE_EMBEDDINGS_PROVIDER / _MODEL / _DIMENSIONS: a machine-wide way
// to point every project's embeddings at a self-hosted server without a
// `.lore.json` in each one. Each env var only applies when the matching
// field is still at its "local" schema default — an explicit `.lore.json`
// value for any one of them must always win for that field.
describe("machine-wide embedding env var overrides", () => {
  const ENV_KEYS = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "LORE_EMBEDDINGS_PROVIDER",
    "LORE_EMBEDDINGS_MODEL",
    "LORE_EMBEDDINGS_DIMENSIONS",
  ] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  let providerToken: unknown;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.OPENAI_API_KEY = "nope";
    await load(process.cwd());
    _resetLocalProviderProbe();
    providerToken = _saveAndClearProvider();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
    const cfg = config().search.embeddings as EmbeddingsCfg & {
      baseUrl?: string;
    };
    cfg.provider = "local";
    cfg.model = "nomic-ai/nomic-embed-text-v1.5";
    cfg.dimensions = 768;
    cfg.baseUrl = undefined;
    _restoreProvider(providerToken);
    vi.restoreAllMocks();
  });

  function mockFetchOk() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), {
        status: 200,
      }),
    );
  }

  it("stays on the local provider when no env var is set", () => {
    expect(embeddingStatus().provider).toBe("local");
  });

  it("LORE_EMBEDDINGS_PROVIDER=openai switches off local with no .lore.json", async () => {
    process.env.LORE_EMBEDDINGS_PROVIDER = "openai";
    const fetchSpy = mockFetchOk();

    await embed(["hello"], "query");

    // Default openai model happens to be an alias many self-hosted OpenAI-
    // compatible servers recognize; the point under test is that "openai"
    // (not "local") was selected purely from the env var.
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        body: expect.stringContaining('"model":"text-embedding-3-small"'),
      }),
    );
  });

  it("LORE_EMBEDDINGS_MODEL overrides the default model for the resolved provider", async () => {
    process.env.LORE_EMBEDDINGS_PROVIDER = "openai";
    process.env.LORE_EMBEDDINGS_MODEL = "qwen-embed";
    const fetchSpy = mockFetchOk();

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        body: expect.stringContaining('"model":"qwen-embed"'),
      }),
    );
  });

  it("a non-'text-embedding-3*' LORE_EMBEDDINGS_MODEL never sends a dimensions field", async () => {
    process.env.LORE_EMBEDDINGS_PROVIDER = "openai";
    process.env.LORE_EMBEDDINGS_MODEL = "qwen-embed";
    process.env.LORE_EMBEDDINGS_DIMENSIONS = "4096";
    const fetchSpy = mockFetchOk();

    await embed(["hello"], "query");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.dimensions).toBeUndefined();
  });

  it("caveat: .lore.json explicitly set to 'local' is indistinguishable from the default, so the env var DOES override it", () => {
    process.env.LORE_EMBEDDINGS_PROVIDER = "openai";
    // Simulates a project's .lore.json explicitly writing "local" — same
    // value as the schema default, so this is the one case the env var
    // can't tell apart from "not specified". Documented, not a bug: use a
    // project .lore.json with a non-default value (see next test) to truly
    // pin a provider despite the machine-wide env var.
    (config().search.embeddings as EmbeddingsCfg).provider = "local";
    expect(embeddingStatus().provider).toBe("remote");
  });

  it("an explicit non-default .lore.json provider always wins over the env var", async () => {
    // The env var says "openai"; .lore.json explicitly says "voyage" — a
    // real, non-default choice, so it must win. Proven by which hardcoded
    // provider URL actually gets hit, not just available()'s local/remote
    // bucketing (which can't tell voyage and openai apart).
    process.env.LORE_EMBEDDINGS_PROVIDER = "openai";
    process.env.VOYAGE_API_KEY = "test-voyage-key-abcdefghijklmnop";
    (config().search.embeddings as EmbeddingsCfg).provider = "voyage";
    const fetchSpy = mockFetchOk();

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.voyageai.com/v1/embeddings",
      expect.anything(),
    );
    delete process.env.VOYAGE_API_KEY;
  });

  it("an explicit .lore.json model is not overridden by LORE_EMBEDDINGS_MODEL", async () => {
    process.env.LORE_EMBEDDINGS_PROVIDER = "openai";
    process.env.LORE_EMBEDDINGS_MODEL = "should-not-be-used";
    (config().search.embeddings as EmbeddingsCfg).model = "pinned-model";
    const fetchSpy = mockFetchOk();

    await embed(["hello"], "query");

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.stringContaining('"model":"pinned-model"'),
      }),
    );
  });

  it("an invalid LORE_EMBEDDINGS_PROVIDER value is ignored (stays local)", () => {
    process.env.LORE_EMBEDDINGS_PROVIDER = "not-a-real-provider";
    expect(isAvailable()).toBe(true);
    expect(embeddingStatus().provider).toBe("local");
  });
});

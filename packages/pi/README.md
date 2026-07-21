# @loreai/pi

> **Experimental** — Under active development. APIs, storage format, and behavior may change.

[Lore](https://github.com/BYK/loreai)'s memory engine as a [Pi coding-agent](https://github.com/badlogic/pi-mono) extension. Three-tier storage, distillation, curation, gradient context management, and FTS5-backed recall — wired into Pi's extension hooks.

## Install

Add to your `~/.pi/settings.json`:

```json
{
  "packages": [
    "npm:@loreai/pi@latest"
  ]
}
```

Then run `pi install` once. The extension auto-loads on every Pi session.

## Local embeddings (optional)

By default, recall uses [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) with `nomic-embed-text-v1.5` (768-dim INT8 quantized, ~137 MB) for on-device vector search — no API key required. The model is downloaded on first use and cached locally.

When installed via npm, local embeddings use the native `onnxruntime-node` backend, which may fail on some configurations (e.g. CUDA 13 on Linux/x64 — see [microsoft/onnxruntime#26586](https://github.com/microsoft/onnxruntime/discussions/26586)). When local embeddings aren't available, recall has graceful fallbacks:

1. **Auto-fallback to a hosted provider** — set `VOYAGE_API_KEY` or `OPENAI_API_KEY` in your env. The first `embed()` call detects the missing local provider and swaps over for the rest of the process. No config changes needed.
2. **Pin a hosted provider explicitly** in `.lore.json`:

   ```json
   { "search": { "embeddings": { "provider": "voyage" } } }
   ```

   (also supports `"openai"`; reads `VOYAGE_API_KEY` / `OPENAI_API_KEY` from env).

If none apply, recall transparently falls back to FTS-only search.

### Self-hosted embeddings (`openai` provider + `baseUrl`)

The `"openai"` provider can point at any OpenAI-compatible embeddings endpoint
instead of the real OpenAI API — a local llama.cpp/llama-swap/vLLM/TEI server,
for example. Set `baseUrl` alongside `provider` in `.lore.json`:

```json
{
  "search": {
    "embeddings": {
      "provider": "openai",
      "model": "qwen-embed",
      "baseUrl": "http://localhost:8080/v1"
    }
  }
}
```

`OPENAI_API_KEY` still needs to be set (any non-empty value works if your
server doesn't check it) — self-hosted servers generally don't validate it.
`baseUrl` is the server root including `/v1` (unlike the `LORE_UPSTREAM_*`
env vars below, which are root-only). You can also set it via the
`OPENAI_BASE_URL` env var instead of `.lore.json`; the config value wins when
both are set.

#### Machine-wide, without a `.lore.json` per project

If you want every project on a box to default to your self-hosted embedder —
not just ones that happen to have a `.lore.json` — set these in your shell
profile instead:

```bash
export OPENAI_API_KEY=nope
export OPENAI_BASE_URL=http://10.0.2.240:8080/v1
export LORE_EMBEDDINGS_PROVIDER=openai
export LORE_EMBEDDINGS_MODEL=qwen-embed        # your server's model id
export LORE_EMBEDDINGS_DIMENSIONS=4096         # your model's real output size
```

`LORE_EMBEDDINGS_PROVIDER`/`_MODEL`/`_DIMENSIONS` only apply when the
matching `.lore.json` field is still at its `"local"`-provider default — a
project that sets its own `search.embeddings.provider` to something other
than `"local"` (e.g. pins `"voyage"`) is unaffected. One caveat: a
`.lore.json` that explicitly writes out `"provider": "local"` (same value as
the default) can't be told apart from not setting it at all, so the env var
overrides that case too — opt a project fully out by pinning a *different*
provider instead.

## Local / self-hosted LLM providers

If you use a local LLM server (vllm, llama.cpp, ollama, etc.), set an environment variable so Lore's gateway knows where to forward requests:

```bash
export LORE_UPSTREAM_VLLM=http://localhost:8000
# or
export LORE_UPSTREAM_OLLAMA=http://localhost:11434
```

The URL should be the **server root** — do not include `/v1` (the gateway appends API paths automatically). The naming convention is `LORE_UPSTREAM_<PROVIDER>` where `<PROVIDER>` is the uppercased Pi provider name with hyphens replaced by underscores:

| Provider | Env var |
|----------|---------|
| `vllm` | `LORE_UPSTREAM_VLLM` |
| `llamacpp` | `LORE_UPSTREAM_LLAMACPP` |
| `ollama` | `LORE_UPSTREAM_OLLAMA` |
| `lmstudio` | `LORE_UPSTREAM_LMSTUDIO` |
| `tgi` | `LORE_UPSTREAM_TGI` |
| `litellm` | `LORE_UPSTREAM_LITELLM` |

Cloud providers (Anthropic, OpenAI, etc.) are routed automatically by model name and don't need this.

## Companion packages

Lore ships as three packages sharing the same SQLite database at `~/.local/share/lore/lore.db`:

- **`@loreai/pi`** (you are here) — Pi coding-agent extension
- [`@loreai/opencode`](https://www.npmjs.com/package/@loreai/opencode) — [OpenCode](https://opencode.ai) plugin (also published as [`opencode-lore`](https://www.npmjs.com/package/opencode-lore) legacy alias)
- [`@loreai/core`](https://www.npmjs.com/package/@loreai/core) — shared memory engine

Switching between OpenCode and Pi on the same project preserves the curated knowledge, distillations, and AGENTS.md sync.

## Documentation

Full architecture, benchmarks, configuration, and rationale: **[github.com/BYK/loreai](https://github.com/BYK/loreai)**

## License

FSL-1.1-Apache-2.0 — see [LICENSE](./LICENSE).

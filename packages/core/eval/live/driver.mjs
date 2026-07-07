// Live counterfactual agent-eval driver.
//
// Runs a real OpenCode agent through a multi-session coding task, either WITH
// Lore (routed through an ISOLATED gateway + DB) or WITHOUT (native compaction).
// The two arms are identical except for Lore, so the difference in outcome +
// efficiency (tokens/turns) is attributable to Lore.
//
// Why this design (vs the replay eval): replay freezes the agent's outputs,
// which is exactly what Lore changes. Here the agent acts live, so we measure
// Lore's real impact — including doing the same work with fewer tokens/turns.
//
// Isolation invariants (must never touch the user's real gateway/DB):
//   - Each arm/run gets its own XDG_{CONFIG,DATA,CACHE,STATE}_HOME + project dir.
//   - The Lore arm starts its OWN gateway on a unique port with its OWN
//     LORE_DB_PATH, and points OpenCode at it via LORE_GATEWAY_URL (which is
//     probed first, so it never falls through to the real defaults 3207/5673).
//
// Usage:
//   bun driver.mjs --task <task.json> --arm lore|nolore --model <prov/model> \
//     --out <dir> [--gw-dist <path>] [--keep]
//
// Emits <out>/result.json with per-session + total metrics.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

// ---- args ----------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--"))
      acc.push([
        cur.slice(2),
        arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true",
      ]);
    return acc;
  }, []),
);
const TASK = JSON.parse(fs.readFileSync(args.task, "utf8"));
const ARM = args.arm; // "lore" | "nolore"
const MODEL = args.model; // e.g. "minimax-coding-plan/MiniMax-M3"
const OUT = path.resolve(args.out);
const AUTH_SRC =
  args["auth"] ||
  path.join(
    process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`,
    "opencode/auth.json",
  );
// Fresh trunk build (NOT the user's active installed plugin) — see #1211.
const LORE_BUILD =
  args["lore-build"] || "/home/byk/.local/share/lore-worktrees/eval-live";
const REAL_LORE_PLUGIN = args["lore-plugin"] || `${LORE_BUILD}/eval-plugin.ts`;
const GW_DIST =
  args["gw-dist"] || `${LORE_BUILD}/packages/gateway/dist/index.bun.js`;
// Map an answering model (opencode "provider/model") to a Lore worker model on
// the SAME provider. minimax-coding-plan maps to Lore's "minimax" route; every
// other provider reuses the answering model itself (same provider by construction).
function defaultWorkerFor(model) {
  const prov = String(model).split("/")[0];
  if (prov === "minimax-coding-plan" || prov === "minimax")
    return "minimax/MiniMax-M3";
  return model;
}
// The worker API key MUST match the worker model's provider. Hardcoding one key
// (e.g. minimax) silently auth-fails the worker for every other provider, so
// distillation never runs and Lore falls back to temporal-only recall (a
// confounded, under-credited result). Map the worker provider -> auth.json entry.
function workerKeyFor(workerModel, authSrc) {
  const prov = String(workerModel).split("/")[0];
  const authName = prov === "minimax" ? "minimax-coding-plan" : prov;
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authSrc, "utf8"));
  } catch {
    return "";
  }
  const entry = auth[authName];
  if (!entry) return ""; // anonymous provider (e.g. opencode/Zen) — no keyed worker
  return entry.key || entry.access || entry.apiKey || "";
}
// Lore's background worker (distillation/knowledge extraction) MUST use the same
// PROVIDER as the answering model — otherwise a test can silently route worker
// traffic to an unrelated (and possibly exhausted/rate-limited) provider. E.g.
// answering on opencode/deepseek but worker on minimax/MiniMax-M3 sends all
// distillation to the M3 coding plan; if that plan is throttled the worker 429s,
// distillation never completes, and Lore captures 0 knowledge → unfair 0/N.
// Default the worker to the SAME provider as --model; override with --worker-model.
const WORKER_MODEL = args["worker-model"] || defaultWorkerFor(MODEL);
{
  const wp = WORKER_MODEL.split("/")[0];
  const mp = MODEL.split("/")[0];
  if (wp !== mp && !args["worker-model"]) {
    console.error(
      `[warn] worker provider '${wp}' != answering provider '${mp}' — pass --worker-model to keep them on one provider`,
    );
  }
}
const OPENCODE = args["opencode"] || "opencode";
const SESSION_TIMEOUT = Number(args["session-timeout"] || "900"); // seconds per session

if (!ARM || !MODEL || !args.task || !args.out) {
  console.error("required: --task --arm --model --out");
  process.exit(2);
}

// ---- helpers -------------------------------------------------------------
const sh = (cmd, cwd) =>
  new Promise((res) => {
    const p = spawn("bash", ["-c", cmd], { cwd, stdio: "ignore" });
    p.on("exit", (code) => res(code ?? 1));
  });

async function freePort() {
  return await new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

async function probeHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Parse an `opencode run --format json` event stream into metrics.
function parseSession(jsonlPath) {
  const m = {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    toolCalls: 0,
    toolsByName: {},
    text: "",
    peakContext: 0,
  };
  const raw = fs.existsSync(jsonlPath)
    ? fs.readFileSync(jsonlPath, "utf8")
    : "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const part = o.part || {};
    if (o.type === "step_finish") {
      m.steps++;
      const t = part.tokens || {};
      m.tokensIn += t.input || 0;
      m.tokensOut += t.output || 0;
      m.cacheRead += (t.cache && t.cache.read) || 0;
      m.cacheWrite += (t.cache && t.cache.write) || 0;
      m.cost += part.cost || 0;
      // peak context = largest single-step input footprint (input + cache that
      // turn). On a non-compacting model this ~= how big the session grew, which
      // is how we calibrate task size to force compaction on a 200K model.
      const ctx =
        (t.input || 0) +
        ((t.cache && t.cache.read) || 0) +
        ((t.cache && t.cache.write) || 0);
      if (ctx > m.peakContext) m.peakContext = ctx;
    } else if (o.type === "tool_use") {
      m.toolCalls++;
      const name = part.tool || part.name || "?";
      m.toolsByName[name] = (m.toolsByName[name] || 0) + 1;
    } else if (o.type === "text") {
      m.text += part.text || "";
    }
  }
  m.tokensTotal = m.tokensIn + m.tokensOut + m.cacheRead + m.cacheWrite;
  return m;
}

// Count native compactions OpenCode performed, from its session DB. Compaction
// parts aren't emitted to the --format json stream, but a row is persisted.
function countCompactions(dbPath) {
  try {
    const out = require("node:child_process").execSync(
      `python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); ` +
        `n=0;` +
        `n+=c.execute(\\"SELECT COUNT(*) FROM session_message WHERE type='compaction'\\").fetchone()[0];` +
        `n+=c.execute(\\"SELECT COUNT(*) FROM part WHERE data LIKE '%\\\\\\"type\\\\\\":\\\\\\"compaction\\\\\\"%'\\").fetchone()[0];` +
        `print(n)" ${dbPath}`,
      { encoding: "utf8" },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

// ---- setup isolated workspace -------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of [
  "config/opencode",
  "data/opencode",
  "cache",
  "state",
  "project",
  "sessions",
]) {
  fs.mkdirSync(path.join(OUT, d), { recursive: true });
}
fs.copyFileSync(AUTH_SRC, path.join(OUT, "data/opencode/auth.json"));

const project = path.join(OUT, "project");
// Seed the project from a template repo (the benchmark codebase), if provided.
const SEED = args.seed
  ? path.resolve(args.seed)
  : TASK.seed
    ? path.resolve(path.dirname(args.task), TASK.seed)
    : null;
if (SEED && fs.existsSync(SEED)) {
  fs.cpSync(SEED, project, { recursive: true });
}
// Optional per-arm Lore config override so a single build can A/B one knob.
// `--context-sources off` -> contextSources:[]; `--context-sources distillation`
// (or `distillation,temporal`) -> that list.
// `--pre-curation` disables the curator entirely (curator.enabled:false) so
// session-1 facts stay in DISTILLATIONS and are NEVER promoted to knowledge.
// That is the ONLY condition where context-sources can matter: it surfaces the
// pre-curation distillation layer. (With the default forced-curation flow, facts
// land in knowledge and are injected to BOTH arms regardless of contextSources,
// so ON≈OFF and the knob is untestable.) knowledge.enabled stays true so
// context-sources surfacing + distillation embedding still run.
// Written as .lore.json in the project (read by the gateway) BEFORE the seed
// commit so the repo stays clean.
if (ARM === "lore") {
  const loreCfg = {};
  if (
    args["context-sources"] !== undefined &&
    args["context-sources"] !== "true"
  ) {
    const raw = String(args["context-sources"]);
    const cs =
      raw === "off" || raw === "none"
        ? []
        : raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    loreCfg.knowledge = { contextSources: cs };
  }
  if (args["pre-curation"]) {
    loreCfg.curator = { enabled: false };
  }
  // FAIRNESS: --cap-context caps OpenCode's view so the *vanilla* arm's native
  // compaction fires. But Lore's gateway reads the model's REAL context window
  // from models.dev independently, so without this it sees the full (e.g. 1M)
  // window, never crosses its layer-0 budget, and never compresses/recalls —
  // the session's early facts just sit in raw context forever. That is both
  // unfair (Lore gets a bigger effective window than vanilla) AND makes the
  // compaction-tax comparison meaningless (Lore never exercises recall). Cap
  // Lore's layer-0 budget to the SAME effective threshold OpenCode compacts at
  // (~cap − output reserve − autocompact buffer) so both arms manage context at
  // the same point; Lore then compresses its raw window and re-surfaces facts
  // via the recall path (context-sources), exactly the mechanism under test.
  if (args["cap-context"]) {
    const cap = Number(args["cap-context"]);
    const outputReserve = Number(args["cap-output"] || 64000);
    // Match Claude Code / OpenCode autocompact arithmetic: trigger a bit below
    // the hard limit (output reserve + ~13K safety buffer). This is the raw
    // layer-0 ceiling past which Lore must compress.
    const AUTOCOMPACT_BUFFER = 13000;
    const maxLayer0Tokens = Math.max(
      40000,
      cap - outputReserve - AUTOCOMPACT_BUFFER,
    );
    loreCfg.budget = { ...(loreCfg.budget || {}), maxLayer0Tokens };
  }
  if (Object.keys(loreCfg).length > 0) {
    fs.writeFileSync(
      path.join(project, ".lore.json"),
      `${JSON.stringify(loreCfg, null, 2)}\n`,
    );
    console.log(`[lore] config override: ${JSON.stringify(loreCfg)}`);
  }
}
await sh(
  "git init -q && git config user.email e@e.co && git config user.name e && git add -A && git commit -q -m seed --allow-empty",
  project,
);

const openrc = { $schema: "https://opencode.ai/config.json" };
if (ARM === "lore") {
  // Self-contained plugin shim: if no --lore-plugin was passed and the default
  // shim file is absent, generate one in OUT with an ABSOLUTE import so the
  // harness runs from a fresh checkout (and from `lore eval`) with no pre-placed
  // eval-plugin.ts. If a shim already exists (dev build), use it unchanged.
  let pluginPath = REAL_LORE_PLUGIN;
  if (!args["lore-plugin"] && !fs.existsSync(pluginPath)) {
    pluginPath = path.join(OUT, "eval-plugin.ts");
    fs.writeFileSync(
      pluginPath,
      `export { LorePlugin as default } from ${JSON.stringify(`${LORE_BUILD}/packages/opencode/src/index.ts`)};\n`,
    );
  }
  openrc.plugin = [pluginPath];
}
// Correct the model's context limit so OpenCode's native compaction fires
// BEFORE the provider's real hard limit. models.dev advertises MiniMax-M3 at 1M,
// but the coding-plan endpoint rejects requests far below that (ContextOverflow),
// and OpenCode (trusting 1M) never compacts -> errors instead. Capping to the
// real/safe limit makes compaction fire cleanly. Applied to BOTH arms equally
// (OpenCode compaction runs under the Lore plugin too) so the comparison is fair.
if (args["cap-context"]) {
  const [prov, ...m] = MODEL.split("/");
  const modelID = m.join("/");
  openrc.provider = {
    [prov]: {
      models: {
        [modelID]: {
          limit: {
            context: Number(args["cap-context"]),
            output: Number(args["cap-output"] || 64000),
          },
        },
      },
    },
  };
}

// Pin sampling for reproducibility so a probe's pass/fail reflects whether the
// fact was in context, not sampling luck. OpenCode exposes temperature at the
// AGENT level (AgentConfig.temperature is a number); the model-level
// `temperature` is only a boolean capability flag, so it must go on the agent.
// The driver drives every turn with `--agent build`, so set it there. Override
// with --temperature (e.g. 1) to measure realistic sampled behavior. (MoE
// endpoints like M3 aren't fully deterministic even at 0, so N still matters —
// this only removes the avoidable sampling noise.)
{
  const temp = args.temperature !== undefined ? Number(args.temperature) : 0;
  openrc.agent = { ...(openrc.agent || {}), build: { temperature: temp } };
}

// ---- MCP memory competitor arms -----------------------------------------
// Competitors to Lore's automatic memory: MCP memory servers the agent must
// drive via tools (store facts in session 1, recall in session 2). Storage is
// isolated per-arm. An AGENTS.md instructs the realistic memory workflow — Lore
// does this automatically without any instruction, so this is generous to the
// competitor. The config key is "memory" for every server, so tools register as
// `memory_*` and the AGENTS.md text is identical across competitors.
const MEM0_USER = `eval-${path.basename(OUT)}-${Date.now()}`;
const MCP_SERVERS = {
  // MCP-A: official Anthropic knowledge-graph memory server (npx, local JSON).
  "mcp-kg": {
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
    environment: { MEMORY_FILE_PATH: path.join(OUT, "mcp-memory.json") },
  },
  // MCP-B: mem0 CLOUD (official mem0-mcp-server via uvx, backed by app.mem0.ai).
  // Requires MEM0_API_KEY in the driver env. Isolated per-run via a unique
  // MEM0_DEFAULT_USER_ID so cloud memories from different runs never mix.
  "mcp-mem0": {
    command: ["uvx", "mem0-mcp-server"],
    environment: {
      MEM0_API_KEY: process.env.MEM0_API_KEY || "",
      MEM0_DEFAULT_USER_ID: MEM0_USER,
    },
    requiredEnv: ["MEM0_API_KEY"],
  },
  // MCP-C: mnemonic (local SQLite + FTS5 + vector, RRF search, decay/pin/
  // supersede/consolidate — the closest local-DB analogue to Lore). Requires a
  // GEMINI_API_KEY (embeddings + fact extraction). Isolated per-run via HOME so
  // its ~/.mnemonic/<project-hash>/memory.db is unique.
  "mcp-mnemonic": {
    command: [process.env.MNEMONIC_BIN || "mnemonic", "serve"],
    environment: {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
      HOME: path.join(OUT, "mnemonic-home"),
    },
    requiredEnv: ["GEMINI_API_KEY"],
  },
  // MCP-D: basic-memory (local-first markdown + sqlite knowledge graph). No API
  // key. Isolated per-run via HOME so its ~/.basic-memory project is unique.
  "mcp-basicmem": {
    command: ["uvx", "basic-memory", "mcp"],
    environment: { HOME: path.join(OUT, "basicmem-home") },
  },
};
// Realistic note a normal user actually writes when they wire up a memory tool:
// casual, not a coached workflow. This is the DEFAULT for fair comparison —
// Lore needs no note at all, so anything more is generous to the competitor.
const MEMORY_AGENTS_MD_SOFT = `# Notes

You have a persistent memory tool available that carries across sessions. Feel
free to use it to keep track of project context and how I like things done, and
to check it when that would help.
`;

// Over-coached "best case for the competitor" variant (opt in with
// --mcp-agents strong). Unrealistic: real users don't write mandatory memory
// workflows, and offhand preferences don't register as "conventions to store".
const MEMORY_AGENTS_MD_STRONG = `# Persistent cross-session memory — MANDATORY WORKFLOW

You have a persistent memory available via the \`memory_*\` tools. Separate
sessions do NOT share conversation context, so this memory is the ONLY way
project conventions and decisions carry from one session to the next. Using it
is REQUIRED, not optional — treat it as part of every task.

STEP 1 — At the very START of EVERY task, before doing anything else, use your
\`memory_*\` tools to SEARCH / LIST / READ any previously stored project
conventions, decisions, gotchas, and specific values. Follow whatever you find,
even if the current task does not mention it.

STEP 2 — WHENEVER the user states a project convention, decision, gotcha, rule,
or specific value (even in passing), IMMEDIATELY use your \`memory_*\` tools to
STORE / ADD it verbatim, BEFORE you start the coding work. Do this even if the
current task seems unrelated to that fact — later sessions will depend on it.

Never skip these steps. Storing and recalling project knowledge is the single
most important part of your job here.
`;
if (MCP_SERVERS[ARM]) {
  const s = MCP_SERVERS[ARM];
  // PREFLIGHT: a competitor arm with a missing/empty required key runs as a
  // dead no-op and scores a SPURIOUS 0% (the bias artifact the fairness audit
  // caught). Fail loudly instead of silently sabotaging the competitor.
  for (const k of s.requiredEnv || []) {
    if (!process.env[k]) {
      console.error(
        `[FATAL] arm '${ARM}' requires env ${k} but it is empty/unset — refusing to run a dead competitor backend that would score a bogus 0%. Set ${k} and retry.`,
      );
      process.exit(2);
    }
  }
  openrc.mcp = {
    memory: {
      type: "local",
      command: s.command,
      enabled: true,
      environment: s.environment,
      timeout: 60000,
    },
  };
  const agentsMd =
    args["mcp-agents"] === "strong"
      ? MEMORY_AGENTS_MD_STRONG
      : MEMORY_AGENTS_MD_SOFT;
  fs.writeFileSync(path.join(project, "AGENTS.md"), agentsMd);
}
fs.writeFileSync(
  path.join(OUT, "config/opencode/opencode.json"),
  JSON.stringify(openrc),
);

const baseEnv = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(OUT, "config"),
  XDG_DATA_HOME: path.join(OUT, "data"),
  XDG_CACHE_HOME: path.join(OUT, "cache"),
  XDG_STATE_HOME: path.join(OUT, "state"),
  OPENCODE_TEST_HOME: OUT,
};

// ---- Lore arm: start isolated gateway -----------------------------------
let gw = null;
let gwPort = null;
const loreDb = path.join(OUT, "data", "lore.db");
if (ARM === "lore") {
  gwPort = await freePort();
  const key = workerKeyFor(WORKER_MODEL, AUTH_SRC);
  if (!key)
    console.error(
      `[warn] no worker API key for provider '${WORKER_MODEL.split("/")[0]}' — background distillation will not run (temporal-only recall)`,
    );
  const launcher = path.join(OUT, "iso-gateway.mjs");
  fs.writeFileSync(
    launcher,
    `const { startGateway } = await import(process.env.ISO_GW_DIST);
const h = await startGateway({ port: Number(process.env.ISO_GW_PORT), quiet: false, local: true });
console.log("ISO_GATEWAY_READY port=" + h.port + " owned=" + h.owned);
if (!h.owned) { console.error("FATAL not owned"); process.exit(3); }
setInterval(() => {}, 1 << 30);`,
  );
  const gwLog = fs.openSync(path.join(OUT, "gateway.log"), "w");
  gw = spawn("bun", [launcher], {
    env: {
      ...baseEnv,
      ISO_GW_DIST: GW_DIST,
      ISO_GW_PORT: String(gwPort),
      LORE_DB_PATH: loreDb,
      LORE_LISTEN_HOST: "127.0.0.1",
      LORE_LISTEN_PORT: String(gwPort),
      LORE_WORKER_API_KEY: key,
      LORE_WORKER_MODEL: WORKER_MODEL,
      LORE_IDLE_TIMEOUT: "2",
      LORE_BATCH_DISABLED: "1",
    },
    stdio: ["ignore", gwLog, gwLog],
    detached: true,
  });
  const ok = await probeHealth(gwPort);
  if (!ok) {
    console.error(
      "isolated gateway failed to become healthy — see gateway.log",
    );
    try {
      process.kill(-gw.pid);
    } catch {}
    process.exit(4);
  }
  console.log(`[${ARM}] isolated gateway ready on ${gwPort} (db ${loreDb})`);
}

// ---- run sessions --------------------------------------------------------
// A task has `sessions` (each a SEPARATE OpenCode session — cross-session
// memory test). A session may have `turns` (multiple --continue turns within
// ONE session — within-session growth/compaction test). Back-compat: a session
// with a bare `prompt` is treated as a single turn. A turn may set `blob` (a
// file path, relative to the task dir) whose contents are inlined into the
// user message — a large mandatory reference the agent cannot script around,
// used to drive context past the compaction threshold.
// Large `blob` content is piped via STDIN (OpenCode reads piped stdin and
// appends it to the message as: <argv message> + "\n" + <stdin>). This bypasses
// the 128KB single-arg limit AND lands in the user message, which OpenCode does
// NOT prune mid-session (only old tool outputs are pruned) — so it reliably
// grows context toward the compaction threshold.
function runOpencode(
  prompt,
  sessionOut,
  { isCommand = false, cont = false, stdin = null } = {},
) {
  return new Promise((res) => {
    const env = { ...baseEnv, PWD: project };
    if (ARM === "lore") env.LORE_GATEWAY_URL = `http://127.0.0.1:${gwPort}`;
    const a = [
      "run",
      "--format",
      "json",
      "--model",
      MODEL,
      "--agent",
      "build",
      "--dangerously-skip-permissions",
    ];
    if (cont) a.push("--continue");
    if (isCommand) a.push("--command", prompt);
    else a.push(prompt);
    const outFd = fs.openSync(sessionOut, "w");
    const errFd = fs.openSync(sessionOut.replace(/\.json$/, ".err"), "w");
    const p = spawn(OPENCODE, a, {
      cwd: project,
      env,
      stdio: [stdin != null ? "pipe" : "ignore", outFd, errFd],
    });
    if (stdin != null) {
      try {
        p.stdin.write(stdin);
        p.stdin.end();
      } catch {}
    }
    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
    }, SESSION_TIMEOUT * 1000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      res(code ?? 1);
    });
  });
}

const taskDir = path.dirname(path.resolve(args.task));
const blobFor = (turn) =>
  turn.blob ? fs.readFileSync(path.resolve(taskDir, turn.blob), "utf8") : null;

// Locate the sqlite-vec extension shipped in the lore build so we can read the
// vec0 embedding tables directly (embedding coverage). fs-walk (not glob) because
// the pnpm store lives under the dot-dir `.pnpm`, which globs skip by default.
function findVecExtension(loreBuild) {
  try {
    const pnpm = path.join(loreBuild, "node_modules", ".pnpm");
    for (const d of fs.readdirSync(pnpm)) {
      if (!d.startsWith("sqlite-vec-")) continue;
      const inner = path.join(pnpm, d, "node_modules");
      for (const pkg of fs.readdirSync(inner)) {
        if (!pkg.startsWith("sqlite-vec-")) continue;
        for (const f of fs.readdirSync(path.join(inner, pkg))) {
          if (/^vec0\.(so|dylib|dll)$/.test(f)) {
            return path.join(inner, pkg, f);
          }
        }
      }
    }
  } catch {
    /* pnpm layout not found */
  }
  return null;
}

// Wait for Lore's background pipeline to drain before the next (fresh) session,
// instead of a blind fixed sleep. The cross-session probe depends on session-1's
// facts being distilled AND embedded so session-2 can vector-surface them;
// distillation and the embedding backfill run ASYNC after the turn, so a fixed
// wait raced them. We poll the isolated DB until (1) the distillation count holds
// steady and (2) every embeddable distillation has a vec0 row (full embedding
// coverage) — the precise "ready" signal. If the vec extension can't be loaded
// we degrade to count-stable + a fixed grace. Capped so it can never hang.
async function waitForMemoryReady(
  dbPath,
  loreBuild,
  { maxMs = 300000, stableMs = 15000, graceMs = 12000, pollMs = 2000 } = {},
) {
  // Minimum embedding coverage (embedded / embeddable) before we trust "ready".
  // The backfill runs in bursts with pauses; a plateau can occur MID-backfill,
  // so we must not accept a partial count. Empirically every run reaches ~100%
  // if given time (verified: runs that settled at 73–75% ended at 24/24, 23/23),
  // and partial-coverage settles measurably hurt recall (full-coverage runs
  // scored 11/12 probes vs 5/8 for partial). Require near-complete coverage;
  // 0.9 (not 1.0) tolerates the rare row the internal embed filter skips.
  const COVERAGE_FLOOR = 0.9;
  const { Database } = await import("bun:sqlite");
  const vecExt = findVecExtension(loreBuild);
  const t0 = Date.now();
  let last = "";
  let stableSince = 0;
  while (Date.now() - t0 < maxMs) {
    let d = 0;
    let k = 0;
    let want = 0;
    let have = null; // null = no vec introspection available
    let ok = false;
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        if (vecExt) {
          try {
            db.loadExtension(vecExt);
          } catch {
            /* fall back to grace below */
          }
        }
        d = db.query("SELECT count(*) AS n FROM distillations").get()?.n ?? 0;
        k = db.query("SELECT count(*) AS n FROM knowledge").get()?.n ?? 0;
        want =
          db
            .query(
              "SELECT count(*) AS n FROM distillations WHERE archived = 0 AND observations != ''",
            )
            .get()?.n ?? 0;
        try {
          // Count only vec rows for LIVE (non-archived, non-empty) distillations
          // so the coverage ratio matches `want`. distillation_vec retains rows
          // for archived/meta-distilled rows too, so a bare COUNT(*) over-counts
          // (produced the bogus 22/6 = 367% log). Join back to the base table.
          have =
            db
              .query(
                "SELECT count(*) AS n FROM distillation_vec v JOIN distillations d ON d.id = v.id WHERE d.archived = 0 AND d.observations != ''",
              )
              .get()?.n ?? 0;
        } catch {
          have = null; // extension not loaded / table not readable
        }
        ok = true;
      } finally {
        db.close();
      }
    } catch {
      /* db not ready yet */
    }
    // Stability signature includes the embedding count (`have`) when we can read
    // it, so "stable" means BOTH distillation writes AND the embedding backfill
    // have quiesced — the precise pipeline-drained signal. (We don't require
    // have === want: the embed filter legitimately skips some rows, so an exact
    // match can never arrive; a settled, non-growing vec count is the real "done".)
    const sig = ok ? `${d}:${have ?? "x"}:${k}` : "err";
    if (ok && d > 0 && sig === last) {
      if (!stableSince) stableSince = Date.now();
    } else {
      stableSince = 0;
      last = sig;
    }
    const stable = stableSince > 0 && Date.now() - stableSince >= stableMs;
    if (stable) {
      if (have === null) {
        // No vec introspection (extension missing) — degrade to a fixed grace.
        console.log(
          `    [lore] memory settled (no vec introspection): distillations=${d} knowledge=${k} (+${graceMs}ms grace)`,
        );
        await new Promise((r) => setTimeout(r, graceMs));
        return { distillations: d, knowledge: k, embedded: null };
      }
      const ratio = want > 0 ? have / want : 1;
      if (want === 0 || (have > 0 && ratio >= COVERAGE_FLOOR)) {
        // Embeddings are present (or nothing to embed), sufficiently complete,
        // and no longer changing → the backfill has genuinely drained.
        console.log(
          `    [lore] memory ready: distillations=${d} embedded=${have}/${want} (${(ratio * 100).toFixed(0)}%) knowledge=${k}`,
        );
        return { distillations: d, knowledge: k, embedded: have };
      }
      // Plateaued below the coverage floor → a transient backfill stall, NOT
      // completion. Keep polling until it resumes (or maxMs → grace below).
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Never reached full coverage within the cap — surface it loudly so a
  // low-coverage (potentially under-embedded) run can be spotted/excluded.
  const finalRatio = last.split(":");
  console.log(
    `    [lore] WARN memory settle TIMEOUT after ${maxMs}ms (last=${last}) — proceeding at possibly-incomplete coverage`,
  );
  void finalRatio;
  await new Promise((r) => setTimeout(r, graceMs));
  return null;
}

const sessionMetrics = [];
for (let i = 0; i < TASK.sessions.length; i++) {
  const s = TASK.sessions[i];
  const turns = s.turns || [{ prompt: s.prompt }];
  console.log(
    `[${ARM}] session ${i + 1}/${TASK.sessions.length}: ${s.id} (${turns.length} turn(s))`,
  );
  const merged = {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    toolCalls: 0,
    toolsByName: {},
    text: "",
    peakContext: 0,
    wallSec: 0,
    session: s.id,
    exit: 0,
    turns: [],
  };
  for (let j = 0; j < turns.length; j++) {
    // Lore in-session recall settle: distillation embeds are fire-and-forget and
    // the FIRST embed pays a ~20s cold model load, so on a single-session task
    // the buried facts stated early are not yet retrievable (distillation_vec
    // empty) by the time the final probe turn runs — Lore silently degrades to
    // FTS/temporal-only and under-scores. Before the LAST turn of a SINGLE-session
    // task, wait for the embedding backfill to quiesce (same gate used between
    // sessions). This mirrors a real user pausing between turns; it does NOT
    // change what the model sees, only that its own memory has finished indexing.
    if (
      ARM === "lore" &&
      TASK.sessions.length === 1 &&
      j === turns.length - 1 &&
      turns.length > 1
    ) {
      const ready = await waitForMemoryReady(loreDb, LORE_BUILD, {
        maxMs: Number(args["lore-settle-max"] || 180000),
        graceMs: Number(args["lore-embed-grace"] || 12000),
      });
      console.log(
        `    [lore] in-session settle before probe turn: distillations=${ready?.distillations ?? "?"} embedded=${ready?.embedded ?? "?"} knowledge=${ready?.knowledge ?? "?"}`,
      );
    }
    const tOut = path.join(OUT, "sessions", `s${i + 1}-${s.id}-t${j + 1}.json`);
    const t0 = Date.now();
    const code = await runOpencode(turns[j].prompt || "", tOut, {
      cont: j > 0,
      stdin: blobFor(turns[j]),
    });
    const wall = (Date.now() - t0) / 1000;
    const tm = parseSession(tOut);
    merged.steps += tm.steps;
    merged.tokensIn += tm.tokensIn;
    merged.tokensOut += tm.tokensOut;
    merged.cacheRead += tm.cacheRead;
    merged.cacheWrite += tm.cacheWrite;
    merged.cost += tm.cost;
    merged.toolCalls += tm.toolCalls;
    for (const [name, c] of Object.entries(tm.toolsByName || {})) {
      merged.toolsByName[name] = (merged.toolsByName[name] || 0) + c;
    }
    merged.wallSec += wall;
    merged.peakContext = Math.max(merged.peakContext, tm.peakContext);
    merged.exit = code || merged.exit;
    merged.turns.push({
      steps: tm.steps,
      peakContext: tm.peakContext,
      tools: tm.toolCalls,
      exit: code,
      wallSec: wall,
    });
    console.log(
      `    turn ${j + 1}/${turns.length}: exit=${code} steps=${tm.steps} peakCtx=${tm.peakContext} tools=${tm.toolCalls} wall=${wall.toFixed(0)}s`,
    );
  }
  merged.tokensTotal =
    merged.tokensIn + merged.tokensOut + merged.cacheRead + merged.cacheWrite;
  sessionMetrics.push(merged);

  // Lore arm: distill this session's context into memory before the next (fresh)
  // session. Default flow FORCES curation (promotes facts -> knowledge, injected
  // to both arms). --pre-curation SKIPS it so facts stay in distillations only,
  // making context-sources the sole channel that can surface them.
  if (ARM === "lore" && i < TASK.sessions.length - 1) {
    if (args["pre-curation"]) {
      console.log(
        "    [lore] pre-curation mode: skipping forced lore:curate (facts remain in distillations, not knowledge)",
      );
    } else {
      // `/lore:curate` is a GATEWAY-intercepted message (matched on the user
      // text), NOT an OpenCode-registered command. Sending it via `--command`
      // makes OpenCode reject it as an unknown command (UnknownError) BEFORE it
      // ever reaches the gateway — so the forced distill+curate silently never
      // ran and cross-session facts were only ever captured by incidental
      // natural distillation. Send it as a normal message with the leading slash
      // so it flows through to the gateway's handleCurateSlashCommand.
      const cOut = path.join(OUT, "sessions", `s${i + 1}-curate.json`);
      await runOpencode("/lore:curate", cOut, { cont: true }).catch(() => {});
      // Surface a curate failure loudly instead of letting it settle on an
      // under-distilled DB (the bug this replaced did exactly that).
      try {
        const cj = JSON.parse(fs.readFileSync(cOut, "utf8"));
        if (cj?.type === "error") {
          console.log(
            `    [lore] WARN /lore:curate returned error: ${cj?.error?.data?.message || "unknown"}`,
          );
        }
      } catch {
        /* non-JSON / streamed output — best effort */
      }
    }
    const ready = await waitForMemoryReady(loreDb, LORE_BUILD, {
      maxMs: Number(args["lore-settle-max"] || 180000),
      graceMs: Number(args["lore-embed-grace"] || 12000),
    });
    // In pre-curation mode knowledge MUST stay empty; if the curator somehow
    // promoted facts anyway, the arm is contaminated (facts would reach OFF via
    // knowledge) — surface it loudly so the run can be discarded.
    if (args["pre-curation"] && ready && ready.knowledge > 0) {
      console.log(
        `    [lore] WARN pre-curation CONTAMINATION: knowledge=${ready.knowledge} (expected 0 — curator should be disabled)`,
      );
    }
  }
  // MCP arms: give async/cloud memory backends time to index before the next
  // (fresh) session searches. mem0 processes `add_memory` server-side
  // ASYNCHRONOUSLY, so an immediate search in session 2 can return empty. This
  // wait is the MCP analogue of Lore's curate+idle step above (fair to both).
  if (MCP_SERVERS[ARM] && i < TASK.sessions.length - 1) {
    await new Promise((r) =>
      setTimeout(r, Number(args["mcp-settle-ms"] || 30000)),
    );
  }
}

// ---- totals + emit -------------------------------------------------------
const totals = sessionMetrics.reduce(
  (a, m) => {
    a.steps += m.steps;
    a.tokensIn += m.tokensIn;
    a.tokensOut += m.tokensOut;
    a.cacheRead += m.cacheRead;
    a.cacheWrite += m.cacheWrite;
    a.tokensTotal += m.tokensTotal;
    a.toolCalls += m.toolCalls;
    a.cost += m.cost;
    a.wallSec += m.wallSec;
    a.peakContext = Math.max(a.peakContext, m.peakContext);
    return a;
  },
  {
    steps: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokensTotal: 0,
    toolCalls: 0,
    cost: 0,
    wallSec: 0,
    peakContext: 0,
  },
);
const compactions = countCompactions(
  path.join(OUT, "data/opencode/opencode.db"),
);

// Validity gate (fairness audit P0 #3): a competitor MCP arm that made ZERO
// memory_* tool calls never stored/retrieved anything — its 0/N is a dead-
// backend ARTIFACT, not a genuine result. Flag it so scoring/aggregation can
// exclude it instead of publishing a bogus 0%.
const memoryToolCalls = sessionMetrics.reduce((n, m) => {
  for (const [name, c] of Object.entries(m.toolsByName || {})) {
    if (/memory|mnemonic|mem0/i.test(name)) n += c;
  }
  return n;
}, 0);
let valid = true;
let invalidReason = null;
if (MCP_SERVERS[ARM] && memoryToolCalls === 0) {
  valid = false;
  invalidReason = "competitor arm made zero memory_* tool calls (dead backend)";
  console.error(
    `[${ARM}] WARN INVALID RUN: ${invalidReason} — this run must be EXCLUDED, not scored as 0.`,
  );
}

fs.writeFileSync(
  path.join(OUT, "result.json"),
  JSON.stringify(
    {
      arm: ARM,
      model: MODEL,
      task: TASK.id,
      gwPort,
      compactions,
      memoryToolCalls,
      valid,
      invalidReason,
      sessions: sessionMetrics,
      totals,
    },
    null,
    2,
  ),
);
console.log(
  `[${ARM}] DONE totals: steps=${totals.steps} tokens=${totals.tokensTotal} peakCtx=${totals.peakContext} compactions=${compactions} tools=${totals.toolCalls} wall=${totals.wallSec.toFixed(0)}s`,
);

// ---- teardown ------------------------------------------------------------
if (gw) {
  try {
    process.kill(-gw.pid);
  } catch {
    try {
      gw.kill("SIGKILL");
    } catch {}
  }
}
if (args.keep !== "true") {
  // keep project + sessions + result; drop bulky caches
  fs.rmSync(path.join(OUT, "cache"), { recursive: true, force: true });
}
process.exit(0);

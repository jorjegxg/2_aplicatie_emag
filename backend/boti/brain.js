/**
 * Creierul boților: Claude prin Agent SDK (rulează Claude Code în container, fără unelte de scriere).
 *
 * Contul: tokenul salvat din pagina Boți (criptat în boti_setari), altfel CLAUDE_CODE_OAUTH_TOKEN
 * (din `claude setup-token`, abonamentul tău) sau ANTHROPIC_API_KEY din .env. Schimbarea contului
 * nu cere restart: fiecare cerere pornește cu tokenul curent.
 */
const fs = require("fs");
const path = require("path");
const { query: dbQuery } = require("../pg");
const { encryptJson, decryptJson } = require("../crypto-secrets");

const WORK_DIR = path.join(__dirname, "..", "data", "boti", "work");
// Sesiunile Claude (pentru conversații reluate) stau pe volumul montat, nu în containerul efemer.
const CONFIG_DIR = path.join(__dirname, "..", "data", "boti", "claude");
const SETTING_KEY = "claude";

let sdkPromise = null;
const sdk = () => (sdkPromise = sdkPromise || import("@anthropic-ai/claude-agent-sdk"));

async function savedAccount() {
  const { rows } = await dbQuery(`SELECT valoare FROM boti_setari WHERE cheie = $1`, [SETTING_KEY]);
  if (!rows[0]?.valoare) return null;
  try {
    return decryptJson(rows[0].valoare);
  } catch {
    return null;
  }
}

/** { tip: "oauth" | "api", token, sursa } sau null dacă nu e niciun cont. */
async function account() {
  const saved = await savedAccount();
  if (saved?.token) return { ...saved, sursa: "pagina Boți" };
  const oauth = String(process.env.CLAUDE_CODE_OAUTH_TOKEN || "").trim();
  if (oauth) return { tip: "oauth", token: oauth, sursa: ".env" };
  const api = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (api) return { tip: "api", token: api, sursa: ".env" };
  return null;
}

async function saveAccount({ token, nume }) {
  const t = String(token || "").trim();
  if (!t) {
    await dbQuery(`DELETE FROM boti_setari WHERE cheie = $1`, [SETTING_KEY]);
    return;
  }
  // Codul din browser (are „#”) se lipește în terminalul lui `claude setup-token`, nu aici.
  if (!/^sk-ant-/i.test(t)) {
    const err = new Error(
      t.includes("#")
        ? "Ăsta e codul din browser: lipește-l în terminalul unde rulează `claude setup-token`; acolo primești tokenul sk-ant-oat01-…, pe acela îl pui aici"
        : "Tokenul trebuie să înceapă cu sk-ant-oat01-… (din `claude setup-token`) sau sk-ant-api… (cheie API)"
    );
    err.status = 400;
    err.expected = true;
    throw err;
  }
  // sk-ant-api… = cheie API; sk-ant-oat… = token de abonament.
  const tip = /^sk-ant-api/i.test(t) ? "api" : "oauth";
  await dbQuery(
    `INSERT INTO boti_setari (cheie, valoare, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (cheie) DO UPDATE SET valoare = EXCLUDED.valoare, updated_at = now()`,
    [SETTING_KEY, encryptJson({ tip, token: t, nume: String(nume || "").trim() || null })]
  );
}

function envFor(acc) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR, CLAUDE_AGENT_SDK_CLIENT_APP: "emag-boti/1.0" };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  if (acc.tip === "api") env.ANTHROPIC_API_KEY = acc.token;
  else env.CLAUDE_CODE_OAUTH_TOKEN = acc.token;
  return env;
}

function noAccountError() {
  const err = new Error("Niciun cont Claude: pune tokenul din `claude setup-token` în pagina Boți → Cont Claude");
  err.status = 400;
  err.expected = true;
  return err;
}

/**
 * O cerere către Claude.
 *   system, prompt      textele
 *   server              serverul MCP cu uneltele de citire (vezi tools.js), opțional; cleanup() la final
 *   schema              JSON schema → răspunsul vine în `structured`
 *   resume              session_id de reluat (conversații)
 *   signal              AbortSignal (oprirea botului)
 * → { text, structured, sessionId, costUsd }
 */
async function ask({ system, prompt, model = "sonnet", server = null, schema = null, resume = null, signal = null, maxTurns = 30 }) {
  const acc = await account();
  if (!acc) throw noAccountError();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const { query } = await sdk();

  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const options = {
    model,
    systemPrompt: system,
    cwd: WORK_DIR,
    env: envFor(acc),
    // Niciun tool din Claude Code (Bash, Write, Edit, WebFetch...): doar uneltele noastre de citire.
    tools: [],
    settingSources: [],
    permissionMode: "dontAsk",
    maxTurns,
    abortController,
  };
  if (server) {
    options.mcpServers = { date: server.config };
    options.allowedTools = server.names.map((n) => `mcp__date__${n}`);
  }
  if (schema) options.outputFormat = { type: "json_schema", schema };
  if (resume) options.resume = resume;

  let result = null;
  let sessionId = resume;
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.session_id) sessionId = msg.session_id;
      if (msg.type === "result") result = msg;
    }
  } finally {
    await server?.cleanup?.().catch(() => {});
  }
  if (!result) throw new Error("Claude nu a răspuns");
  if (result.subtype !== "success") {
    const detail = (result.errors || []).join("; ") || result.subtype;
    throw new Error(`Claude: ${detail}`);
  }
  if (result.is_error) throw new Error(`Claude: ${String(result.result || "eroare").slice(0, 300)}`);
  return {
    text: String(result.result || "").trim(),
    structured: result.structured_output ?? null,
    sessionId,
    costUsd: Number(result.total_cost_usd) || null,
  };
}

/** Ce cont e activ: e-mail / abonament (din Claude Code), fără să arate tokenul. */
async function status() {
  const acc = await account();
  if (!acc) return { configurat: false };
  const out = { configurat: true, tip: acc.tip, sursa: acc.sursa, nume: acc.nume || null, token: `…${acc.token.slice(-6)}` };
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const { query } = await sdk();
    const q = query({
      prompt: "Răspunde doar: ok",
      options: { model: "haiku", cwd: WORK_DIR, env: envFor(acc), tools: [], settingSources: [], maxTurns: 1, persistSession: false },
    });
    const info = await q.accountInfo();
    for await (const msg of q) {
      if (msg.type === "result") {
        out.merge = msg.subtype === "success" && !msg.is_error;
        if (!out.merge) out.eroare = String(msg.result || (msg.errors || []).join("; ") || msg.subtype).slice(0, 300);
      }
    }
    out.email = info?.email || null;
    out.abonament = info?.subscriptionType || null;
  } catch (e) {
    out.merge = false;
    out.eroare = e.message;
  }
  return out;
}

module.exports = { ask, account, saveAccount, status };

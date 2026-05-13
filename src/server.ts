// DAP Trigger plugin — backend.
//
// Single HTTP server on a fixed port (DAP_PLUGIN_PORT, default 3020) that serves:
//   POST /dap/trigger     — webhook from DAP, HMAC-SHA256 verified
//   GET  /dap/health      — health probe
//   GET  /api/recent      — recent trigger history (frontend via api.rpc)
//   GET  /api/config      — exposed config (no secrets, frontend via api.rpc)
//
// CloudCLI's plugin host expects a "{\"ready\":true,\"port\":N}" line on stdout
// to discover where to proxy api.rpc() calls. Caddy is configured separately to
// reverse-proxy /dap/* to the same port so DAP can hit /dap/trigger externally.

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CloudCLI's plugin-process-manager strips host env (only PATH/HOME/NODE_ENV
// reach plugin children). So we load our secret + overrides from a sibling
// file `.secret` (chmod 600) instead of relying on the parent env.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
function loadFileConfig(): Record<string, string> {
  const cfg: Record<string, string> = {};
  const p = path.join(PLUGIN_DIR, '.secret');
  if (!existsSync(p)) return cfg;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    cfg[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return cfg;
}
const fileCfg = loadFileConfig();
function cfg(name: string, fallback = ''): string {
  return fileCfg[name] ?? process.env[name] ?? fallback;
}

interface TriggerRecord {
  request_id: string;
  received_at: string;
  finished_at?: string;
  status: 'running' | 'completed' | 'failed';
  repo?: string;
  branch?: string;
  prompt: string;
  exit_code?: number;
  error?: string;
  duration_ms?: number;
  result_preview?: string;
}

const SECRET           = cfg('DAP_WEBHOOK_SECRET');
const PORT             = parseInt(cfg('DAP_PLUGIN_PORT', '3020'), 10);
const WORKSPACES_ROOT  = cfg('WORKSPACES_ROOT', '/home/repos');
const CLAUDE_BIN       = cfg('CLAUDE_BIN', '/usr/local/bin/claude');
const RUN_TIMEOUT_MS   = parseInt(cfg('RUN_TIMEOUT_MS', '600000'), 10);
// Optional: SSH host for `git clone` when the caller passes a short
// "group/repo" form. Empty = require callers to pass a full git URL.
const GIT_DEFAULT_HOST = cfg('GIT_DEFAULT_HOST', '');
// Public URL the host is reachable on. Surfaced via /api/config so the UI tab
// can show the canonical webhook URL to copy into DAP / other systems.
const PUBLIC_BASE_URL  = cfg('PUBLIC_BASE_URL', '');
const MAX_HISTORY      = 100;

// File-backed history so records survive plugin-process restarts.
// CloudCLI's plugin host recycles plugin children on host restart / hot reload.
const HISTORY_FILE = path.join(PLUGIN_DIR, '.history.json');
function loadHistory(): TriggerRecord[] {
  try {
    const raw = readFileSync(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}
function persistHistory() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[dap-trigger] history persist failed: ${(e as Error).message}\n`);
  }
}
const history: TriggerRecord[] = loadHistory();
process.stderr.write(`[dap-trigger] loaded ${history.length} history records from ${HISTORY_FILE}\n`);

function pushHistory(rec: TriggerRecord) {
  history.unshift(rec);
  while (history.length > MAX_HISTORY) history.pop();
  persistHistory();
}

function verifyHmac(body: Buffer, header: string | undefined): boolean {
  if (!SECRET || !header) return false;
  const m = header.match(/^sha256=([a-f0-9]+)$/i);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const a = Buffer.from(m[1], 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signHmac(s: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(s).digest('hex');
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const c = chunk as Buffer;
    total += c.length;
    if (total > 2 * 1024 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function resolveRepoDir(repoSpec: string): string {
  const parts = repoSpec.split(/[\/:]/);
  const last = (parts[parts.length - 1] || repoSpec).replace(/\.git$/, '');
  return path.join(WORKSPACES_ROOT, last);
}

interface ExecResult { code: number; stdout: string; stderr: string; }

function exec(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('exit', code => resolve({ code: code ?? -1, stdout: out, stderr: err }));
    p.on('error', (e: Error) => resolve({ code: -1, stdout: '', stderr: e.message }));
  });
}

async function ensureRepo(repo: string | undefined, branch: string | undefined): Promise<string | null> {
  if (!repo) return null;
  const targetDir = resolveRepoDir(repo);
  let exists = false;
  try { await fs.access(path.join(targetDir, '.git')); exists = true; } catch { /* clone below */ }
  if (!exists) {
    let url: string;
    if (/^(git@|https?:\/\/)/.test(repo)) {
      url = repo;
    } else if (GIT_DEFAULT_HOST) {
      url = `git@${GIT_DEFAULT_HOST}:${repo}.git`;
    } else {
      throw new Error(
        `repo '${repo}' isn't cloned and no GIT_DEFAULT_HOST is set — pass a full git URL or set GIT_DEFAULT_HOST in the plugin's .secret`,
      );
    }
    const r = await exec('git', ['clone', '--quiet', url, targetDir]);
    if (r.code !== 0) throw new Error('git clone failed: ' + r.stderr.trim());
  }
  if (branch) {
    await exec('git', ['fetch', '--quiet', 'origin', branch], { cwd: targetDir });
    const co = await exec('git', ['checkout', '--quiet', branch], { cwd: targetDir });
    if (co.code !== 0) throw new Error(`checkout ${branch}: ${co.stderr.trim()}`);
    await exec('git', ['pull', '--ff-only', '--quiet', 'origin', branch], { cwd: targetDir });
  }
  return targetDir;
}

function runClaude(prompt: string, cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, ['-p', prompt, '--output-format', 'json'], {
      cwd,
      env: { ...process.env, HOME: '/root' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), RUN_TIMEOUT_MS);
    proc.on('exit', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    proc.on('error', (e: Error) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: e.message }); });
  });
}

async function sendCallback(url: string | undefined, payload: Record<string, unknown>): Promise<void> {
  if (!url) {
    process.stderr.write(`[dap-trigger] no callback_url for ${payload.request_id}, skipping callback\n`);
    return;
  }
  // DAP's WebhookController binds the body as `{ Message?, Body? }`. We put a
  // human-readable summary + Claude's assistant text into `message` so the
  // resulting chat turn carries the real result; the full structured payload
  // goes into `body` for richer agent reasoning if needed.
  const claudeResult = (payload.result as any)?.result;
  const claudeText =
    typeof claudeResult === 'string' ? claudeResult :
    claudeResult != null ? JSON.stringify(claudeResult) :
    (payload.stdout as string | undefined) ?? '(no output)';
  const summary = payload.status === 'completed'
    ? `✅ CloudCLI run ${payload.request_id} finished (exit ${payload.exit_code}).`
    : `❌ CloudCLI run ${payload.request_id} failed: ${(payload.error as string | undefined) ?? `exit ${payload.exit_code}`}`;
  const wrapped = JSON.stringify({
    message: `${summary}\n\n${claudeText}`,
    body: payload,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CloudCLI-Signature': signHmac(wrapped),
        'X-Request-Id': String(payload.request_id),
      },
      body: wrapped,
      signal: AbortSignal.timeout(30_000),
    });
    process.stderr.write(`[dap-trigger] callback -> ${url} status=${res.status} request_id=${payload.request_id}\n`);
  } catch (e) {
    process.stderr.write(`[dap-trigger] callback failed for ${payload.request_id}: ${(e as Error).message}\n`);
  }
}

async function handleTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  if (!verifyHmac(raw, req.headers['x-dap-signature'] as string | undefined)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid signature' }));
    return;
  }
  let body: any;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid json' }));
    return;
  }

  const request_id  = body.request_id || crypto.randomUUID();
  const received_at = new Date().toISOString();
  const startedAt   = Date.now();

  const record: TriggerRecord = {
    request_id, received_at, status: 'running',
    repo: body.repo, branch: body.branch,
    prompt: (body.prompt || '').slice(0, 1000),
  };
  pushHistory(record);

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ request_id, status: 'accepted', received_at }));

  // Fire-and-forget pipeline
  (async () => {
    let payload: Record<string, unknown>;
    try {
      const cwd = (await ensureRepo(body.repo, body.branch)) || WORKSPACES_ROOT;
      const fullPrompt = body.context
        ? `${body.prompt}\n\n--- Context from DAP ---\n${
            typeof body.context === 'string' ? body.context : JSON.stringify(body.context, null, 2)
          }`
        : body.prompt;
      const result = await runClaude(fullPrompt, cwd);
      let claudeJson: any = null;
      try { claudeJson = JSON.parse(result.stdout); } catch { /* unparseable */ }
      record.status      = result.code === 0 ? 'completed' : 'failed';
      record.exit_code   = result.code;
      record.finished_at = new Date().toISOString();
      record.duration_ms = Date.now() - startedAt;
      record.result_preview = String(claudeJson?.result ?? result.stdout ?? '').slice(0, 500);
      persistHistory();
      payload = {
        request_id, status: record.status,
        started_at: received_at, finished_at: record.finished_at,
        exit_code: result.code, cwd,
        result: claudeJson,
        stdout: claudeJson ? undefined : result.stdout,
        stderr: result.stderr || undefined,
      };
    } catch (e) {
      const msg = (e as Error).message;
      record.status      = 'failed';
      record.error       = msg;
      record.finished_at = new Date().toISOString();
      record.duration_ms = Date.now() - startedAt;
      persistHistory();
      payload = {
        request_id, status: 'failed',
        started_at: received_at, finished_at: record.finished_at,
        error: msg,
      };
    }
    await sendCallback(body.callback_url, payload);
  })().catch(e => console.error('[dap-trigger] async error:', (e as Error).message));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'POST' && req.url === '/dap/trigger') return await handleTrigger(req, res);

    if (req.method === 'GET' && req.url === '/dap/health') {
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), history_size: history.length }));
      return;
    }
    // Plugin RPC routes (called from the frontend via api.rpc)
    if (req.method === 'GET' && req.url === '/api/recent') {
      process.stderr.write(`[dap-trigger] GET /api/recent (history=${history.length})\n`);
      res.end(JSON.stringify({ records: history }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/config') {
      const webhookUrl = PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/dap/trigger`
        : '(set PUBLIC_BASE_URL in the plugin .secret to display the public webhook URL)';
      res.end(JSON.stringify({
        webhook_url: webhookUrl,
        signing_header: 'X-DAP-Signature',
        signing_algorithm: 'HMAC-SHA256(body)',
        callback_signature_header: 'X-CloudCLI-Signature',
        workspaces_root: WORKSPACES_ROOT,
        git_default_host: GIT_DEFAULT_HOST || null,
        secret_configured: !!SECRET,
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // Required: CloudCLI plugin host parses this JSON to know our port
  console.log(JSON.stringify({ ready: true, port: PORT }));
});

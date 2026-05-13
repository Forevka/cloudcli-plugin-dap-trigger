# cloudcli-plugin-dap-trigger

A [CloudCLI](https://cloudcli.ai) plugin that exposes an HMAC-authenticated webhook endpoint, runs `claude -p` (Claude Code) in a target repo on receipt, and POSTs the result back to a caller-supplied callback URL. Designed for **agent-to-agent (A2A) integration** — letting another agent platform (e.g., the [DevCom Agentic Platform / DAP](https://github.com/devcom-dap)) delegate coding tasks to a remote Claude Code session running on your CloudCLI host, then receive the result asynchronously.

The plugin adds:

- `POST /dap/trigger` — HMAC-SHA256-signed webhook receiver that 202-ACKs and runs `claude -p` async.
- `GET  /dap/health` — health probe (no auth).
- A **DAP Triggers** UI tab showing recent runs (file-backed, survives plugin restarts, last 100 records).
- Outbound callback signing: every callback POST includes `X-CloudCLI-Signature: sha256=<hmac>` so the receiver can verify integrity.

## How it works

```
┌────────────────────┐  POST /dap/trigger             ┌────────────────────────┐
│  Calling system    │  X-DAP-Signature: sha256=…     │  CloudCLI + plugin     │
│  (DAP / n8n /      │ ─────────────────────────────▶ │                        │
│   GitHub Action)   │                                │  spawns `claude -p`    │
│                    │                                │  in /home/repos/<repo> │
└────────────────────┘                                │                        │
        ▲                                             │  on completion ▶       │
        │  POST <callback_url>                        │                        │
        │  X-CloudCLI-Signature: sha256=…             │                        │
        └─────────────────────────────────────────────┘
```

## Requirements

- A working CloudCLI install (self-hosted, `npx @cloudcli-ai/cloudcli` or globally-installed `cloudcli`).
- Claude Code (`@anthropic-ai/claude-code`) installed and logged in on the host (the plugin spawns `claude` as a child process; auth comes from `~/.claude/.credentials.json`).
- Node.js ≥ 18 (the plugin's backend is plain Node, no native deps).
- A reverse proxy (Caddy / nginx / etc.) terminating HTTPS in front of CloudCLI, exposing the `/dap/*` paths to the public internet. **Do not skip this** — the webhook MUST be HTTPS.
- TypeScript toolchain (for `npm run build`).

## Install

CloudCLI supports installing plugins from a git URL. In the CloudCLI UI:

> Settings → Plugins → Add plugin from git → `https://github.com/<your-fork>/cloudcli-plugin-dap-trigger`

Or manually:

```bash
cd ~/.claude-code-ui/plugins
git clone https://github.com/<your-fork>/cloudcli-plugin-dap-trigger.git dap-trigger
cd dap-trigger
npm install
npm run build
```

Then restart CloudCLI:

```bash
systemctl restart cloudcli   # systemd
# or stop & re-run `cloudcli` / `npx @cloudcli-ai/cloudcli`
```

The plugin auto-starts on the next CloudCLI launch — confirm with `journalctl -u cloudcli | grep dap-trigger` (look for `Plugins] Server started for "dap-trigger" on port 3020`).

## Configure

CloudCLI's plugin host sanitizes child-process environment for security (only `PATH` / `HOME` / `NODE_ENV` reach plugin backends), so secrets are read from a sibling file `.secret` in the plugin directory.

```bash
cat > ~/.claude-code-ui/plugins/dap-trigger/.secret <<'EOF'
# HMAC shared secret — must match the secret the calling system signs with.
# Generate a strong one: openssl rand -hex 32
DAP_WEBHOOK_SECRET=<64-char-hex-secret>

# Public URL your CloudCLI host is reachable on. Used in the UI tab to show
# the canonical webhook URL to copy into your other agent platform.
PUBLIC_BASE_URL=https://your-cloudcli-host.example.com

# Optional. If set, lets callers pass repo as "group/name" (short form);
# plugin will `git clone git@${GIT_DEFAULT_HOST}:group/name.git` on first use.
# Leave unset to require callers to pass full git URLs.
GIT_DEFAULT_HOST=gitlab.example.com

# Optional overrides — defaults shown.
# DAP_PLUGIN_PORT=3020
# WORKSPACES_ROOT=/home/repos
# CLAUDE_BIN=/usr/local/bin/claude
# RUN_TIMEOUT_MS=600000
EOF
chmod 600 ~/.claude-code-ui/plugins/dap-trigger/.secret
systemctl restart cloudcli
```

Then create the workspace root and make sure Claude Code can `git clone` into it (e.g., add an SSH key for `git@${GIT_DEFAULT_HOST}` to your CloudCLI host's user):

```bash
sudo mkdir -p /home/repos
sudo chown $(whoami):$(whoami) /home/repos
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_git -N ""
cat ~/.ssh/id_ed25519_git.pub   # add to your git provider
```

## Expose `/dap/*` over HTTPS

The plugin listens on `127.0.0.1:3020` only. Front it with your reverse proxy. Example Caddy snippet (see `examples/Caddyfile.example`):

```caddyfile
your-cloudcli-host.example.com {
    handle /dap/* {
        reverse_proxy 127.0.0.1:3020
    }
    handle {
        reverse_proxy 127.0.0.1:3001        # ← whatever CloudCLI itself listens on
    }
}
```

Restart Caddy and verify:

```bash
curl https://your-cloudcli-host.example.com/dap/health
# → {"status":"ok","uptime":42.17,"history_size":0}
```

## Webhook contract

### Request

```http
POST /dap/trigger HTTP/1.1
Host: your-cloudcli-host.example.com
Content-Type: application/json
X-DAP-Signature: sha256=<hex hmac-sha256 of the raw body, using DAP_WEBHOOK_SECRET>

{
  "request_id":  "<caller-supplied uuid>",   // optional; plugin generates one if missing
  "prompt":      "<what claude should do>",  // required, non-empty
  "repo":        "group/name | git@host:group/name.git | https://host/group/name.git",  // optional
  "branch":      "main",                     // optional, defaults to current
  "context":     "<extra paragraph passed verbatim after the prompt>",  // optional
  "callback_url":"https://your-other-system/webhook/path"               // optional
}
```

### Response

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "request_id": "...", "status": "accepted", "received_at": "ISO-8601" }
```

Non-202 responses:

| code | meaning |
|---|---|
| 400 | malformed JSON |
| 401 | missing or invalid `X-DAP-Signature` |
| 502/504 | reverse proxy issue, plugin not running |

### Async callback (only if `callback_url` provided)

When `claude -p` finishes, the plugin POSTs:

```http
POST <callback_url> HTTP/1.1
Content-Type: application/json
X-CloudCLI-Signature: sha256=<hmac of body>
X-Request-Id: <request_id>

{
  "request_id":  "...",
  "status":      "completed" | "failed",
  "started_at":  "ISO-8601",
  "finished_at": "ISO-8601",
  "exit_code":   0,
  "cwd":         "/home/repos/<repo>",
  "result":      <claude's parsed JSON output, or null>,
  "stdout":      "<raw stdout if result couldn't be parsed>",
  "stderr":      "<stderr, only on failure>"
}
```

`claude -p --output-format json` returns `{ result: "<final assistant text>", ... }` — the plugin parses and forwards as `result`.

If you're posting back into another agent platform (DAP / similar), most of them accept this body shape natively but extract their own message field. See `examples/dap-integration.md` notes if you need to adapt the body to a `{ message, body }` shape for DAP specifically.

## Generate a matching HMAC (caller side)

Any common HMAC library works. Bash/openssl:

```bash
SECRET="<your DAP_WEBHOOK_SECRET>"
BODY='{"prompt":"hello"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST https://your-cloudcli-host.example.com/dap/trigger \
     -H "X-DAP-Signature: $SIG" -H "Content-Type: application/json" \
     -d "$BODY"
```

Node.js:

```js
const crypto = require('node:crypto');
const body = JSON.stringify({ prompt: 'hello' });
const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
await fetch('https://your-cloudcli-host.example.com/dap/trigger', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-DAP-Signature': sig },
  body,
});
```

C# (.NET):

```csharp
using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
var sig = "sha256=" + Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
```

## Security model

- **Webhook auth = HMAC-SHA256 of the raw body** with a 32-byte (64-hex-char) shared secret. Constant-time compare; signature mismatch returns 401 with no body-shape leak.
- **The plugin runs `claude -p` with whatever filesystem rights its parent CloudCLI process has.** If you run CloudCLI as `root`, the plugin runs as `root` — Claude Code can then do anything on the box. Recommendation: run CloudCLI as a dedicated unprivileged user.
- **Workspace containment**: callers can only operate on repos under `WORKSPACES_ROOT` (default `/home/repos`). Path traversal in `repo` is rejected by basename extraction.
- **Outbound callbacks are signed too** with the same secret (header `X-CloudCLI-Signature`). Your callback endpoint should verify before acting on the body — otherwise anyone who can reach your callback URL can inject results.
- **The `.secret` file is read once on plugin start.** Rotate by editing the file and restarting CloudCLI.
- **History file `.history.json` contains prompt previews (1000 chars) and result previews (500 chars).** Don't put highly sensitive data into prompts if you don't want them on disk.

## Source

Single Node 18+ HTTP server, no native deps, no framework. ~330 lines of TypeScript that compile down to plain ESM. See `src/server.ts`.

## Build from source

```bash
git clone https://github.com/<your-fork>/cloudcli-plugin-dap-trigger.git
cd cloudcli-plugin-dap-trigger
npm install
npm run build
# dist/ now contains server.js + index.js + types.js
```

## Troubleshooting

**Plugin doesn't appear in the CloudCLI UI** — check `journalctl -u cloudcli | grep dap-trigger`. Look for `Plugins] Server started for "dap-trigger" on port 3020`. If you see a `findModule` error, run `npm install && npm run build` again. If you see a syntax error, your Node is < 18.

**Webhook returns 401 even with matching secret** — make sure your caller is hashing the **raw body bytes**, not a re-serialized form. If your HTTP client whitespace-formats JSON, the signature will mismatch. Send the body verbatim as a string and hash that exact string.

**`/dap/trigger` returns 502/504 via Caddy** — plugin's port (3020) isn't reachable from Caddy. Check `ss -tlnp | grep 3020` and the Caddy config.

**The DAP Triggers UI tab is empty after a trigger** — open browser DevTools → Network. You should see a `GET /api/plugins/dap-trigger/rpc/api/recent` every 3s while the tab is open. If you see `401`, your CloudCLI auth session expired; reload the page. If you see no request at all, the plugin frontend bundle failed to load — check the Console tab for errors, or force-reload (Ctrl+Shift+R) to bust the host cache.

**`claude -p` fails with auth error** — SSH to the host and run `claude` once, complete the device-code OAuth. Credentials land in `~/.claude/.credentials.json` and are picked up automatically by spawned `claude` processes.

**History wiped on plugin restart** — pre-1.0 versions only kept history in memory. As of v1.0 the plugin file-persists to `<pluginDir>/.history.json` (chmod 600, last 100 records). Verify the file exists after a run; if not, the plugin user can't write to its own dir.

## License

MIT — see [LICENSE](./LICENSE).

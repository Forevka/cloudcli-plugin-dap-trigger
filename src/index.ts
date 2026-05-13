// DAP Trigger plugin — frontend tab.
// Shows config + a live-refreshing table of recent webhook triggers.

import type { PluginAPI, PluginContext, TriggerRecord, PluginConfig } from './types.js';

let pollTimer: number | null = null;
let unsub: (() => void) | null = null;

function fmtAge(ms: number | undefined): string {
  if (!ms) return '…';
  if (ms < 1000) return ms + 'ms';
  return Math.round(ms / 1000) + 's';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    running:   '#f59e0b',
    completed: '#10b981',
    failed:    '#ef4444',
  };
  const c = colors[status] || '#888';
  return `<span style="background:${c};color:#000;padding:2px 8px;border-radius:4px;font-size:0.75em;font-weight:600">${escapeHtml(status)}</span>`;
}

function themeColors(theme: 'dark' | 'light') {
  return theme === 'light'
    ? { bg: '#fafafa', surface: '#fff', border: '#e5e5e5', text: '#111', muted: '#666' }
    : { bg: '#1a1a1a', surface: '#222', border: '#333', text: '#eaeaea', muted: '#999' };
}

async function render(container: HTMLElement, api: PluginAPI) {
  const theme = api.context.theme;
  const c = themeColors(theme);

  let config: PluginConfig | null = null;
  let records: TriggerRecord[] = [];
  let error: string | null = null;

  try {
    config  = (await api.rpc('GET', '/api/config'))  as PluginConfig;
    const r = (await api.rpc('GET', '/api/recent'))  as { records: TriggerRecord[] };
    records = r.records || [];
  } catch (e) {
    error = (e as Error).message;
  }

  const rows = records.length === 0
    ? `<tr><td colspan="6" style="padding:1rem;color:${c.muted}">No triggers yet. Send a signed POST to <code>${escapeHtml(config?.webhook_url || '')}</code> to test.</td></tr>`
    : records.map(r => `
        <tr style="border-bottom:1px solid ${c.border}">
          <td style="padding:6px 8px;font-family:monospace;font-size:0.85em">${escapeHtml(new Date(r.received_at).toLocaleTimeString())}</td>
          <td style="padding:6px 8px">${statusBadge(r.status)}</td>
          <td style="padding:6px 8px;font-size:0.9em">${escapeHtml(r.repo || '—')}</td>
          <td style="padding:6px 8px;font-size:0.9em">${escapeHtml(r.branch || '—')}</td>
          <td style="padding:6px 8px;font-family:monospace;font-size:0.85em;text-align:right">${escapeHtml(fmtAge(r.duration_ms))}</td>
          <td style="padding:6px 8px;font-size:0.85em;color:${c.muted};max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
              title="${escapeHtml(r.result_preview || r.error || '')}">${escapeHtml((r.result_preview || r.error || '').slice(0, 80))}</td>
        </tr>`).join('');

  const secretWarning = config && !config.secret_configured
    ? `<div style="background:#7c2d12;color:#fff;padding:8px 12px;border-radius:6px;margin-bottom:1rem">
         ⚠ <strong>DAP_WEBHOOK_SECRET not set</strong> — webhook will reject all calls.
         Set it on the cloudcli systemd drop-in and restart the service.
       </div>`
    : '';

  container.innerHTML = `
    <div style="padding:1.25rem;background:${c.bg};color:${c.text};font-family:system-ui,sans-serif;min-height:100%">
      <h2 style="margin-top:0">DAP Triggers</h2>
      ${secretWarning}
      ${error ? `<div style="color:#ef4444">Error: ${escapeHtml(error)}</div>` : ''}
      ${config ? `
        <div style="background:${c.surface};border:1px solid ${c.border};border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.9em;line-height:1.7">
          <strong>Webhook:</strong> <code>${escapeHtml(config.webhook_url)}</code><br/>
          <strong>Signature:</strong> <code>${escapeHtml(config.signing_header)}: sha256=&lt;hex&gt;</code> (${escapeHtml(config.signing_algorithm)})<br/>
          <strong>Callback signed with:</strong> <code>${escapeHtml(config.callback_signature_header)}</code><br/>
          <strong>Workspace root:</strong> <code>${escapeHtml(config.workspaces_root)}</code>
        </div>` : ''}
      <table style="width:100%;border-collapse:collapse;background:${c.surface};border:1px solid ${c.border};border-radius:6px;overflow:hidden">
        <thead>
          <tr style="background:${c.bg};border-bottom:1px solid ${c.border};text-align:left">
            <th style="padding:8px;font-weight:600;font-size:0.85em">Time</th>
            <th style="padding:8px;font-weight:600;font-size:0.85em">Status</th>
            <th style="padding:8px;font-weight:600;font-size:0.85em">Repo</th>
            <th style="padding:8px;font-weight:600;font-size:0.85em">Branch</th>
            <th style="padding:8px;font-weight:600;font-size:0.85em;text-align:right">Duration</th>
            <th style="padding:8px;font-weight:600;font-size:0.85em">Result preview</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:1rem;font-size:0.8em;color:${c.muted}">Auto-refreshes every 3s. History persists across plugin restarts (file-backed, last 100 runs).</p>
    </div>
  `;
}

// CloudCLI's plugin loader expects NAMED exports `mount`/`unmount`, not a
// default-exported object. Mirrors the cloudcli-plugin-starter convention.
export async function mount(container: HTMLElement, api: PluginAPI): Promise<void> {
  await render(container, api);
  pollTimer = window.setInterval(() => { render(container, api).catch(() => { /* ignored */ }); }, 3000);
  unsub = api.onContextChange((_ctx: PluginContext) => {
    render(container, api).catch(() => { /* ignored */ });
  });
}

export function unmount(_container: HTMLElement): void {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  if (unsub) { unsub(); unsub = null; }
}

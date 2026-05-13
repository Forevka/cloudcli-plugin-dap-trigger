// Mirror of CloudCLI's PluginAPI surface — copied verbatim from the starter
// so we get type-safety in our frontend without depending on cloudcli internals.

export interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

export interface TriggerRecord {
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

export interface PluginConfig {
  webhook_url: string;
  signing_header: string;
  signing_algorithm: string;
  callback_signature_header: string;
  workspaces_root: string;
  secret_configured: boolean;
}

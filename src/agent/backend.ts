import { invoke } from "@tauri-apps/api/core";
import type { Transport } from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const LOCAL_RUNTIME = "http://127.0.0.1:43127";
const memoryKeys = new Map<string, string>();

const WEB_ENDPOINTS: Record<string, { base: string; headers: (key: string) => Record<string, string> }> = {
  anthropic: { base: "https://api.anthropic.com", headers: key => ({
    "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"
  }) },
  openrouter: { base: "https://openrouter.ai/api", headers: key => ({ Authorization: `Bearer ${key}` }) }
};

async function localRequest(path: string, method = "GET", body?: unknown) {
  let response: Response;
  try {
    response = await fetch(LOCAL_RUNTIME + path, {
      method, headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error("The AI 3D Studio local runtime is not running. Start it using the instructions in local-runtime/README.md.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Local runtime error (${response.status}).`);
  return data;
}

export const backend = {
  secureStorage: isTauri,
  async chatgptStatus(): Promise<{ connected: boolean; email?: string | null; name?: string | null }> {
    return localRequest("/status");
  },
  async connectChatGPT(): Promise<void> { await localRequest("/auth/start", "POST", {}); },
  async disconnectChatGPT(): Promise<void> { await localRequest("/auth/disconnect", "POST", {}); },
  async hasApiKey(provider: string): Promise<boolean> {
    return isTauri() ? invoke<boolean>("has_api_key", { provider }) : memoryKeys.has(provider);
  },
  async setApiKey(provider: string, key: string): Promise<void> {
    if (isTauri()) return invoke<void>("set_api_key", { provider, key });
    if (!key.trim()) throw new Error("API key is empty.");
    memoryKeys.set(provider, key.trim());
  },
  async deleteApiKey(provider: string): Promise<void> {
    if (isTauri()) return invoke<void>("delete_api_key", { provider });
    memoryKeys.delete(provider);
  },
  transport: (provider: string): Transport => async ({ path, body }) => {
    if (provider === "chatgpt") {
      if (path !== "/v1/responses") throw new Error("Unsupported ChatGPT API path.");
      const response = await localRequest("/responses", "POST", body) as any;
      return { status: 200, body: response };
    }
    if (isTauri()) {
      const res = await invoke<{ status: number; body: string }>("ai_request", { provider, path, body });
      return { status: res.status, body: safeParse(res.body) };
    }
    const endpoint = WEB_ENDPOINTS[provider];
    const key = memoryKeys.get(provider);
    if (!endpoint) throw new Error(`Unknown AI provider: ${provider}`);
    if (!key) throw new Error("No API key set. Add one in Settings.");
    if (!path.startsWith("/v1/")) throw new Error("Invalid API path.");
    let res: Response;
    try {
      res = await fetch(endpoint.base + path, {
        method: "POST", headers: { "content-type": "application/json", ...endpoint.headers(key) }, body: JSON.stringify(body)
      });
    } catch (e) { throw new Error(`Network error: ${e instanceof Error ? e.message : e}`); }
    return { status: res.status, body: safeParse(await res.text()) };
  }
};
function safeParse(text: string): unknown { try { return JSON.parse(text); } catch { return null; } }

import { invoke } from "@tauri-apps/api/core";
import type { Transport } from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Two ways to reach an AI provider, same interface:
 *
 * - Desktop (Tauri): the key lives in the Windows Credential Manager and is
 *   attached inside Rust. It never enters the webview.
 * - Web (e.g. GitHub Pages): there is no backend, so the user's own key is held
 *   in this variable ONLY — never localStorage, cookies or files — and is lost on
 *   reload. Requests go straight from the browser to the provider. Anyone using
 *   the web build should use a key with a spend limit.
 */
const memoryKeys = new Map<string, string>();

const WEB_ENDPOINTS: Record<string, { base: string; headers: (key: string) => Record<string, string> }> = {
  anthropic: {
    base: "https://api.anthropic.com",
    headers: key => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Required by Anthropic to acknowledge a key is being used from a browser.
      "anthropic-dangerous-direct-browser-access": "true"
    })
  }
};

export const backend = {
  /** True when keys are stored securely by the OS rather than held in page memory. */
  secureStorage: isTauri,

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
        method: "POST",
        headers: { "content-type": "application/json", ...endpoint.headers(key) },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error(`Network error: ${e instanceof Error ? e.message : e}`);
    }
    return { status: res.status, body: safeParse(await res.text()) };
  }
};

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

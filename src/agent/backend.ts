import { invoke } from "@tauri-apps/api/core";
import type { Transport } from "./types";

export const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * - Desktop (Tauri): keys live in Windows Credential Manager and are attached in Rust.
 * - Web (GitHub Pages): the key is held in this module's memory only and is lost on reload.
 *   Requests go directly from the browser to the selected provider.
 *
 * Browser keys are necessarily available to the page's JavaScript while it is running.
 * For a public deployment, use a limited OpenRouter key and avoid sharing the site with
 * anyone you do not trust.
 */
const memoryKeys = new Map<string, string>();

const WEB_ENDPOINTS: Record<string, { base: string; headers: (key: string) => Record<string, string> }> = {
  anthropic: {
    base: "https://api.anthropic.com",
    headers: key => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    })
  },
  openrouter: {
    base: "https://openrouter.ai/api",
    headers: key => ({ Authorization: `Bearer ${key}` })
  }
};

export const backend = {
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

import { CLAUDE_DEFAULT_MODEL } from "./agent/providers/claude";
import { OPENROUTER_DEFAULT_MODEL } from "./agent/providers/openrouter";
import { CHATGPT_DEFAULT_MODEL } from "./agent/providers/chatgpt";
import { DEFAULT_PERMISSIONS, type PermissionSettings } from "./agent/permissions";

export type ProviderId = "anthropic" | "openrouter" | "chatgpt";
export function defaultModelFor(provider: ProviderId): string {
  if (provider === "anthropic") return CLAUDE_DEFAULT_MODEL;
  if (provider === "chatgpt") return CHATGPT_DEFAULT_MODEL;
  return OPENROUTER_DEFAULT_MODEL;
}
export interface AppSettings { provider: ProviderId; model: string; permissions: PermissionSettings; }
const KEY = "ai3ds.settings.v1";

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    const provider: ProviderId = raw?.provider === "anthropic" || raw?.provider === "chatgpt" ? raw.provider : "openrouter";
    const defaultModel = defaultModelFor(provider);
    if (!raw) return { provider, model: defaultModel, permissions: DEFAULT_PERMISSIONS };
    const model = raw.provider === provider && typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : defaultModel;
    return { provider, model, permissions: { ...DEFAULT_PERMISSIONS, autoApplyLowRisk: raw.permissions?.autoApplyLowRisk !== false } };
  } catch { return { provider: "openrouter", model: OPENROUTER_DEFAULT_MODEL, permissions: DEFAULT_PERMISSIONS }; }
}
export function saveSettings(s: AppSettings) {
  try { localStorage.setItem(KEY, JSON.stringify({
    provider: s.provider, model: s.model, permissions: { autoApplyLowRisk: s.permissions.autoApplyLowRisk }
  })); } catch { /* storage unavailable */ }
}

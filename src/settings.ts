import { CLAUDE_DEFAULT_MODEL } from "./agent/providers/claude";
import { DEFAULT_PERMISSIONS, type PermissionSettings } from "./agent/permissions";

/** Non-secret preferences only. API keys are NEVER stored here (see src-tauri/src/ai.rs). */
export interface AppSettings {
  model: string;
  permissions: PermissionSettings;
}

const KEY = "ai3ds.settings.v1";

export function loadSettings(): AppSettings {
  const defaults: AppSettings = { model: CLAUDE_DEFAULT_MODEL, permissions: DEFAULT_PERMISSIONS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw) return defaults;
    return {
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : defaults.model,
      permissions: { ...DEFAULT_PERMISSIONS, autoApplyLowRisk: raw.permissions?.autoApplyLowRisk !== false }
    };
  } catch { return defaults; }
}

export function saveSettings(s: AppSettings) {
  try { localStorage.setItem(KEY, JSON.stringify({ model: s.model, permissions: { autoApplyLowRisk: s.permissions.autoApplyLowRisk } })); } catch { /* storage unavailable */ }
}

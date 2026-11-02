import { applyOperation, boundsFor, type ModelOperation, type StudioState } from "../model/store";

/**
 * Hybrid permission policy. This is deterministic application code: the model
 * can neither see nor change it. The agent loop consults it for every tool call.
 */
export interface PermissionSettings {
  /** If false, every modifying call needs approval. */
  autoApplyLowRisk: boolean;
  /** A single scale step within [1/x, x] is "small". */
  maxAutoScaleStep: number;
  /** A single move up to this fraction of the model's largest dimension is "small". */
  maxAutoMoveFraction: number;
  /** Cumulative scale per axis must stay inside [1/x, x] to be auto-approved. */
  maxAutoCumulativeScale: number;
}

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  autoApplyLowRisk: true,
  maxAutoScaleStep: 1.25,
  maxAutoMoveFraction: 0.25,
  maxAutoCumulativeScale: 4
};

export interface PermissionDecision {
  level: "auto" | "approval";
  /** Plain-language reasons shown to the user when approval is required. */
  reasons: string[];
}

export function assessOperation(op: ModelOperation, state: StudioState, s: PermissionSettings): PermissionDecision {
  const reasons: string[] = [];
  if (!s.autoApplyLowRisk) reasons.push("Auto-apply is turned off in settings.");

  if (op.kind === "scale") {
    const step = Math.max(op.factor, 1 / op.factor);
    if (step > s.maxAutoScaleStep) {
      reasons.push(`Large resize (×${op.factor}); auto-apply is limited to ×${(1 / s.maxAutoScaleStep).toFixed(2)}–×${s.maxAutoScaleStep}.`);
    }
  } else if (state.asset) {
    const { size } = boundsFor(state.asset, state.transform);
    const limit = Math.max(...size) * s.maxAutoMoveFraction;
    if (Math.abs(op.amount) > limit) {
      reasons.push(`Large move (${op.amount}); auto-apply is limited to ${(s.maxAutoMoveFraction * 100).toFixed(0)}% of the model's largest dimension.`);
    }
  }

  const next = applyOperation(state.transform, op);
  if (next.scale.some(v => v > s.maxAutoCumulativeScale || v < 1 / s.maxAutoCumulativeScale)) {
    reasons.push("The cumulative scale would drift far from the original size.");
  }
  return { level: reasons.length ? "approval" : "auto", reasons };
}

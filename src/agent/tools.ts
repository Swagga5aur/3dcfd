import { applyOperation, boundsFor, describeOperation, type ModelOperation, type StudioStore } from "../model/store";
import { validate } from "./schema";
import type { ToolSpec } from "./types";

export interface ToolContext {
  store: StudioStore;
}

/** What a modifying tool call would do. Used for permission checks, preview and approval UI. */
export interface ToolPlan {
  summary: string;
  /** If set, the permission policy assesses it and the viewport can preview it. */
  operation?: ModelOperation;
}

export interface Tool {
  spec: ToolSpec;
  /** Present on tools that change the project. Read-only tools omit it. */
  plan?(input: any, ctx: ToolContext): ToolPlan;
  run(input: any, ctx: ToolContext): unknown;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  register(tool: Tool) {
    if (this.tools.has(tool.spec.name)) throw new Error(`Duplicate tool: ${tool.spec.name}`);
    this.tools.set(tool.spec.name, tool);
    return this;
  }
  get(name: string) { return this.tools.get(name); }
  specs(): ToolSpec[] { return [...this.tools.values()].map(t => t.spec); }
  /** Returns validation errors; empty array means valid. */
  validate(tool: Tool, input: unknown) { return validate(tool.spec.inputSchema, input); }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const roundVec = (v: number[]) => v.map(round);

function requireAsset(ctx: ToolContext) {
  const { asset, transform } = ctx.store.getState();
  if (!asset) throw new Error("No model is loaded. Ask the user to import one.");
  return { asset, transform };
}

const getModelInfo: Tool = {
  spec: {
    name: "get_model_info",
    description:
      "Read-only. Returns the loaded model's name, triangle/vertex counts, current size and bounding box in model units, " +
      "its current scale/position, and undo/redo availability. Call this before proposing any change so you reason from real numbers.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  run(_input, ctx) {
    const state = ctx.store.getState();
    if (!state.asset) return { loaded: false };
    const b = boundsFor(state.asset, state.transform);
    return {
      loaded: true,
      name: state.asset.name,
      triangles: state.asset.triangles,
      vertices: state.asset.vertices,
      size: roundVec(b.size),
      boundsMin: roundVec(b.min),
      boundsMax: roundVec(b.max),
      scale: roundVec(state.transform.scale),
      position: roundVec(state.transform.position),
      canUndo: state.undoStack.length > 0,
      canRedo: state.redoStack.length > 0,
      notes: "Units are whatever the source file used (STL has no units). Axes are model axes; the viewport shows Y up."
    };
  }
};

const transformModel: Tool = {
  spec: {
    name: "transform_model",
    description:
      "Resize or move the whole model. Modifies the project and is recorded so it can be undone. " +
      "kind='scale': multiply size by 'factor' (uniformly, or only along 'axis' if given). " +
      "kind='translate': move along 'axis' by 'amount' model units. " +
      "Small changes may apply immediately; larger ones are shown to the user for approval first. " +
      "This changes the object transform only; it does not edit mesh geometry or thicken individual parts.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["scale", "translate"] },
        factor: { type: "number", minimum: 0.05, maximum: 10, description: "Scale multiplier (kind=scale)." },
        axis: { type: "string", enum: ["x", "y", "z"], description: "Axis; optional for scale, required for translate." },
        amount: { type: "number", minimum: -100000, maximum: 100000, description: "Distance in model units (kind=translate)." }
      },
      required: ["kind"],
      additionalProperties: false
    }
  },
  plan(input): ToolPlan {
    const op = toOperation(input);
    return { summary: describeOperation(op), operation: op };
  },
  run(input, ctx) {
    requireAsset(ctx);
    const entry = ctx.store.commit(toOperation(input), "agent");
    return { applied: entry.label, newScale: roundVec(entry.after.scale), newPosition: roundVec(entry.after.position) };
  }
};

/** Cross-field checks the flat schema can't express. Throws with a message the model can act on. */
function toOperation(input: any): ModelOperation {
  if (input.kind === "scale") {
    if (typeof input.factor !== "number") throw new Error("kind=scale requires 'factor'.");
    return input.axis ? { kind: "scale", factor: input.factor, axis: input.axis } : { kind: "scale", factor: input.factor };
  }
  if (typeof input.amount !== "number" || !input.axis) throw new Error("kind=translate requires 'axis' and 'amount'.");
  return { kind: "translate", axis: input.axis, amount: input.amount };
}

const undoOperation: Tool = {
  spec: {
    name: "undo_operation",
    description: "Undo the most recent modelling operation (including ones the user made). Reversible with redo_operation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  plan: () => ({ summary: "Undo the last operation" }),
  run(_i, ctx) {
    const entry = ctx.store.undo();
    return entry ? { undone: entry.label } : { undone: null, note: "Nothing to undo." };
  }
};

const redoOperation: Tool = {
  spec: {
    name: "redo_operation",
    description: "Re-apply the most recently undone operation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  plan: () => ({ summary: "Redo the last undone operation" }),
  run(_i, ctx) {
    const entry = ctx.store.redo();
    return entry ? { redone: entry.label } : { redone: null, note: "Nothing to redo." };
  }
};

const listOperations: Tool = {
  spec: {
    name: "list_operations",
    description: "Read-only. Lists applied operations (oldest first) with who made them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  run(_i, ctx) {
    const { undoStack, redoStack } = ctx.store.getState();
    return { applied: undoStack.map(e => ({ label: e.label, by: e.source, at: e.at })), undoneAndRedoable: redoStack.length };
  }
};

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry().register(getModelInfo).register(transformModel).register(undoOperation).register(redoOperation).register(listOperations);
}

// Re-export so tests/UI can predict a call's effect without running it.
export { applyOperation };

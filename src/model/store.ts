/**
 * Authoritative model state + operation ledger.
 *
 * The viewport only *renders* what is in here. Every change goes through
 * commit(), which records before/after transforms so undo/redo is exact.
 * No Three.js imports: this file is pure and unit-testable.
 */

export type Axis = "x" | "y" | "z";
export type Vec3 = [number, number, number];

export interface Transform {
  position: Vec3;
  scale: Vec3;
}

export type ModelOperation =
  | { kind: "scale"; factor: number; axis?: Axis }
  | { kind: "translate"; axis: Axis; amount: number };

export interface ModelAsset {
  name: string;
  vertices: number;
  triangles: number;
  /** Bounding-box size of the loaded geometry at identity transform. */
  baseSize: Vec3;
}

export interface LedgerEntry {
  id: string;
  label: string;
  operation: ModelOperation;
  before: Transform;
  after: Transform;
  source: "user" | "agent";
  at: string;
}

export interface StudioState {
  asset: ModelAsset | null;
  transform: Transform;
  /** Transient preview of a proposed (not yet approved) operation. */
  preview: Transform | null;
  undoStack: LedgerEntry[];
  redoStack: LedgerEntry[];
}

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
export const IDENTITY: Transform = { position: [0, 0, 0], scale: [1, 1, 1] };

export function applyOperation(t: Transform, op: ModelOperation): Transform {
  const position = [...t.position] as Vec3;
  const scale = [...t.scale] as Vec3;
  if (op.kind === "scale") {
    if (op.axis) scale[AXIS_INDEX[op.axis]] *= op.factor;
    else for (let i = 0; i < 3; i++) scale[i] *= op.factor;
  } else {
    position[AXIS_INDEX[op.axis]] += op.amount;
  }
  return { position, scale };
}

export function describeOperation(op: ModelOperation): string {
  if (op.kind === "scale") {
    return op.axis ? `Scale ${op.axis.toUpperCase()} by ${op.factor}` : `Scale uniformly by ${op.factor}`;
  }
  return `Move ${op.axis.toUpperCase()} by ${op.amount}`;
}

/** World-space size/bounds of the model for a given transform (no rotation yet). */
export function boundsFor(asset: ModelAsset, t: Transform) {
  const size = asset.baseSize.map((s, i) => s * Math.abs(t.scale[i])) as Vec3;
  const min = size.map((s, i) => t.position[i] - s / 2) as Vec3;
  const max = size.map((s, i) => t.position[i] + s / 2) as Vec3;
  return { size, min, max };
}

type Listener = () => void;

export class StudioStore {
  private state: StudioState = emptyState();
  private listeners = new Set<Listener>();

  // Arrow properties so they can be passed straight to useSyncExternalStore.
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = (): StudioState => this.state;

  private set(patch: Partial<StudioState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(l => l());
  }

  /** Loading a model resets transform and history. */
  loadAsset(asset: ModelAsset) {
    this.state = { ...emptyState(), asset };
    this.listeners.forEach(l => l());
  }

  /** Compute what an operation would do, without changing anything. */
  simulate(op: ModelOperation): Transform {
    return applyOperation(this.state.transform, op);
  }

  setPreview(op: ModelOperation | null) {
    this.set({ preview: op ? this.simulate(op) : null });
  }

  commit(op: ModelOperation, source: LedgerEntry["source"]): LedgerEntry {
    if (!this.state.asset) throw new Error("No model is loaded.");
    const before = this.state.transform;
    const after = applyOperation(before, op);
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      label: describeOperation(op),
      operation: op,
      before,
      after,
      source,
      at: new Date().toISOString()
    };
    this.set({ transform: after, preview: null, undoStack: [...this.state.undoStack, entry], redoStack: [] });
    return entry;
  }

  undo(): LedgerEntry | null {
    const entry = this.state.undoStack[this.state.undoStack.length - 1];
    if (!entry) return null;
    this.set({
      transform: entry.before,
      preview: null,
      undoStack: this.state.undoStack.slice(0, -1),
      redoStack: [...this.state.redoStack, entry]
    });
    return entry;
  }

  redo(): LedgerEntry | null {
    const entry = this.state.redoStack[this.state.redoStack.length - 1];
    if (!entry) return null;
    this.set({
      transform: entry.after,
      preview: null,
      undoStack: [...this.state.undoStack, entry],
      redoStack: this.state.redoStack.slice(0, -1)
    });
    return entry;
  }
}

function emptyState(): StudioState {
  return { asset: null, transform: IDENTITY, preview: null, undoStack: [], redoStack: [] };
}

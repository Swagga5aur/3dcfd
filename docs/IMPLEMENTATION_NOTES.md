# Implementation notes (v0.2)

## What exists now (and what was actually verified)

| Piece | File(s) | Status |
| --- | --- | --- |
| Model store + operation ledger, real undo/redo, preview | `src/model/store.ts` | Implemented, **unit-tested** |
| Provider-neutral types | `src/agent/types.ts` | Implemented |
| Tool registry + 5 tools (`get_model_info`, `transform_model`, `undo_operation`, `redo_operation`, `list_operations`) | `src/agent/tools.ts` | Implemented, **unit-tested** |
| Argument validation (one schema → sent to model and used to validate) | `src/agent/schema.ts` | Implemented, **unit-tested** |
| Hybrid permission policy | `src/agent/permissions.ts` | Implemented, **unit-tested** |
| Agent loop (validate → permission → approval → execute) | `src/agent/agentManager.ts` | Implemented, **unit-tested** with a scripted fake provider |
| Claude adapter (Anthropic Messages API, tool use) | `src/agent/providers/claude.ts` | Implemented, **unit-tested against a fake transport**; never called the real API |
| Secure key storage + allowlisted HTTPS (Rust) | `src-tauri/src/ai.rs` | Written, **not compiled** |
| UI: chat, approval card, settings, undo/redo, history | `src/App.tsx`, `src/viewport/Viewport.tsx` | Written, **not run** |

Run the logic tests with `npm install && npm test` (20 tests, no network or API key needed).

## Architecture decision: where the agent loop lives

The original brief says the backend coordinates tool calls. Right now the model's state lives in the webview (Three.js), so running the loop in Rust would mean duplicating that state across the IPC boundary. Instead:

- **Rust** holds the API key and makes the HTTPS call. It exposes only: `has_api_key`, `set_api_key`, `delete_api_key`, `ai_request`. No command returns the key. `ai_request` can only reach hosts hard-coded per provider and only `/v1/…` paths.
- **TypeScript** runs the loop, tool registry and permission policy. These are pure logic with no Three.js dependency.

Simpler alternative considered and rejected: calling the API directly from the webview (needs the key in JS — violates the security requirement). More thorough alternative deferred: move the loop to Rust/Python once geometry processing (Manifold, mesh analysis) is also off the renderer. The tool registry is the seam; tools are plain functions of `(input, ctx)`.

## How the permission system works

1. The model asks for a tool call.
2. Arguments are validated against the tool's schema (bad → error returned to the model, nothing runs).
3. A modifying tool describes its effect (`plan`). The policy (`permissions.ts`) decides `auto` or `approval`. The model cannot see or alter the policy.
4. For `approval`: the viewport shows a preview, the UI shows reasons, and the call runs only if the user clicks Approve. Reject/Cancel returns an error to the model.
5. Default thresholds: single scale step within ×0.8–×1.25, moves ≤25% of largest dimension, cumulative scale within ×0.25–×4. All in `DEFAULT_PERMISSIONS`. "Auto-apply" can be switched off in Settings.

Every modification goes through `StudioStore.commit()` and is recorded, so undo is exact.

## Known limitations

- The Rust backend and UI have not been compiled/run (no Windows/Tauri build environment was available). Expect a few compile fixes on first build.
- `tauri.conf.json` still has `"csp": null`. Tighten before release (needs testing with Vite dev + blob: URLs for GLB loading).
- Operations are whole-object scale/translate only; no geometry editing.
- Chat history is kept in memory only and is cleared when a new model is imported. It is not saved in the project file; saved projects store the transform and operation list, not the mesh.
- No streaming responses; the UI shows "working" until the full reply arrives.
- Long conversations are not summarised or trimmed.
- Printability is not assessed by the permission policy yet.

## Next steps

1. Build on Windows, fix compile errors, test with a real key.
2. Persist the mesh asset + ledger + chat summary in a project folder (SQLite).
3. Mesh representation in the geometry layer (Manifold-3D) so operations work on geometry, not just the object transform.
4. Region selection → tools that take a region.
5. Analysis tools (wall thickness, overhangs) as read-only tools; then their fixes as approval-gated tools.
6. Second provider adapter (OpenAI) to prove the abstraction; streaming.

## Reference projects (licence note)

ScanRuler and stlTexturizer are both **AGPL-3.0**. No code from them is used here. Studying their approach is fine, but copying code into this application would require releasing this application under the AGPL (or obtaining a commercial licence from the author). Decide this before borrowing anything.

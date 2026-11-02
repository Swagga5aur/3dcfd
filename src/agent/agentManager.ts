import type { ModelOperation } from "../model/store";
import { assessOperation, type PermissionDecision, type PermissionSettings } from "./permissions";
import type { ToolContext, ToolRegistry } from "./tools";
import type { AgentMessage, AgentProvider, ContentBlock } from "./types";

export interface ApprovalRequest {
  toolName: string;
  summary: string;
  reasons: string[];
  operation?: ModelOperation;
}

export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; text: string }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; approved: boolean };

export interface AgentManagerOptions {
  /** Looked up on every turn so the user can switch provider without rebuilding the manager. */
  getProvider: () => AgentProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  getPermissions: () => PermissionSettings;
  /** Must resolve true only on an explicit user approval. */
  requestApproval: (request: ApprovalRequest) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
  /** Safety cap on model<->tool round trips per user message. */
  maxSteps?: number;
}

const SYSTEM_PROMPT = `You are the modelling assistant inside AI 3D Studio, a desktop app for preparing 3D models for FDM and resin printing.

You act ONLY through the tools provided. You cannot edit geometry directly, and the app decides whether each change needs the user's approval. If a tool reports that the user rejected a change, accept that, do not retry the same change, and offer an alternative.

Currently available capabilities: inspect the model, resize or move the whole model, undo/redo, and list history. Not available yet: editing individual parts or regions, thickening, textures, displacement, painting, print analysis, text/image-to-3D. If the user asks for something that needs these, say plainly that it is not available yet and suggest the closest thing you can do now. Never claim to have done something you did not do.

Guidelines:
- Call get_model_info before proposing a change, and base numbers on it.
- Only modify the model when the user has asked for a change. For open questions or advice, answer without modifying.
- Prefer one clear operation over many small ones.
- After acting, briefly say what changed (with numbers) and that it can be undone.
- Be concise.`;

export class AgentManager {
  private history: AgentMessage[] = [];
  private running = false;
  private cancelled = false;

  constructor(private opts: AgentManagerOptions) {}

  get isRunning() { return this.running; }
  cancel() { this.cancelled = true; }
  reset() { this.history = []; }
  getHistory(): readonly AgentMessage[] { return this.history; }

  /** Runs one user turn to completion and returns the assistant's final text. */
  async send(userText: string): Promise<string> {
    if (this.running) throw new Error("The assistant is already working on a request.");
    this.running = true;
    this.cancelled = false;
    const startLength = this.history.length;
    try {
      this.history.push({ role: "user", content: [{ type: "text", text: userText }] });
      const maxSteps = this.opts.maxSteps ?? 8;
      let finalText = "";

      for (let step = 0; step < maxSteps; step++) {
        if (this.cancelled) throw new Error("Cancelled.");
        const response = await this.opts.getProvider().complete({
          system: this.systemPrompt(),
          messages: this.history,
          tools: this.opts.registry.specs()
        });
        this.history.push({ role: "assistant", content: response.content });

        const text = response.content.filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text").map(b => b.text).join("\n").trim();
        if (text) { finalText = text; this.opts.onEvent?.({ type: "assistant_text", text }); }

        const calls = response.content.filter((b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call");
        if (calls.length === 0) {
          if (response.stopReason === "max_tokens") finalText ||= "The response was cut off. Please try a shorter request.";
          return finalText;
        }

        // Every tool_call MUST get a tool_result, even on cancel, or the history becomes invalid for the next turn.
        const results: ContentBlock[] = [];
        for (const call of calls) {
          results.push(this.cancelled
            ? { type: "tool_result", callId: call.id, content: "Cancelled by user.", isError: true }
            : await this.executeCall(call));
        }
        this.history.push({ role: "user", content: results });
      }
      return finalText || "I stopped because this request needed too many steps. Please break it into smaller parts.";
    } catch (e) {
      // Drop the unfinished turn so a failed request can't leave a dangling tool_call in the history.
      this.history.length = startLength;
      throw e;
    } finally {
      this.running = false;
      this.opts.ctx.store.setPreview(null);
    }
  }

  private systemPrompt(): string {
    const { asset } = this.opts.ctx.store.getState();
    return `${SYSTEM_PROMPT}\n\nCurrent project: ${asset ? `model "${asset.name}" is loaded.` : "no model is loaded yet."}`;
  }

  /** The single place where tools run. Validation -> permission -> (approval) -> execute. */
  private async executeCall(call: Extract<ContentBlock, { type: "tool_call" }>): Promise<ContentBlock> {
    const fail = (text: string): ContentBlock => {
      this.opts.onEvent?.({ type: "tool_result", name: call.name, ok: false, text });
      return { type: "tool_result", callId: call.id, content: text, isError: true };
    };
    const { registry, ctx } = this.opts;
    const tool = registry.get(call.name);
    if (!tool) return fail(`Unknown tool "${call.name}".`);

    const errors = registry.validate(tool, call.input);
    if (errors.length) return fail(`Invalid arguments: ${errors.join("; ")}`);

    this.opts.onEvent?.({ type: "tool_call", name: call.name, input: call.input });
    try {
      if (tool.plan) {
        const plan = tool.plan(call.input, ctx);
        const decision: PermissionDecision = plan.operation
          ? assessOperation(plan.operation, ctx.store.getState(), this.opts.getPermissions())
          : { level: "auto", reasons: [] }; // undo/redo: reversible, no new geometry
        if (decision.level === "approval") {
          const request: ApprovalRequest = { toolName: call.name, summary: plan.summary, reasons: decision.reasons, operation: plan.operation };
          ctx.store.setPreview(plan.operation ?? null);
          this.opts.onEvent?.({ type: "approval_requested", request });
          let approved = false;
          try { approved = (await this.opts.requestApproval(request)) === true; }
          finally { ctx.store.setPreview(null); }
          this.opts.onEvent?.({ type: "approval_resolved", approved });
          if (!approved) return fail("The user rejected this change. The model was not modified.");
        }
      }
      const output = JSON.stringify(tool.run(call.input, ctx));
      this.opts.onEvent?.({ type: "tool_result", name: call.name, ok: true, text: output });
      return { type: "tool_result", callId: call.id, content: output };
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Tool failed.");
    }
  }
}

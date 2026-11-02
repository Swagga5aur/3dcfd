import {
  ProviderError,
  type AgentMessage, type AgentProvider, type ContentBlock,
  type ProviderRequest, type ProviderResponse, type StopReason, type Transport
} from "../types";

export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5-5";

interface ClaudeOptions {
  transport: Transport;
  model?: string;
  maxTokens?: number;
}

/** Anthropic Messages API adapter. Translates neutral types <-> Claude wire format. */
export class ClaudeProvider implements AgentProvider {
  readonly id = "anthropic";
  readonly label: string;
  constructor(private opts: ClaudeOptions) {
    this.label = `Claude (${opts.model ?? CLAUDE_DEFAULT_MODEL})`;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const { status, body } = await this.opts.transport({
      path: "/v1/messages",
      body: {
        model: this.opts.model ?? CLAUDE_DEFAULT_MODEL,
        max_tokens: this.opts.maxTokens ?? 2048,
        system: req.system,
        messages: req.messages.map(toClaudeMessage),
        tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
      }
    });
    if (status < 200 || status >= 300) throw new ProviderError(describeError(status, body), status);
    return fromClaudeResponse(body);
  }
}

function toClaudeMessage(m: AgentMessage) {
  return {
    role: m.role,
    content: m.content.map(b => {
      switch (b.type) {
        case "text": return { type: "text", text: b.text };
        case "tool_call": return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result": return { type: "tool_result", tool_use_id: b.callId, content: b.content, ...(b.isError ? { is_error: true } : {}) };
      }
    })
  };
}

function fromClaudeResponse(body: any): ProviderResponse {
  if (!body || !Array.isArray(body.content)) throw new ProviderError("Unexpected response from Claude API.");
  const content: ContentBlock[] = [];
  for (const b of body.content) {
    if (b.type === "text") content.push({ type: "text", text: String(b.text ?? "") });
    else if (b.type === "tool_use") content.push({ type: "tool_call", id: b.id, name: b.name, input: b.input ?? {} });
    // Other block types (e.g. thinking) are ignored on purpose.
  }
  const stop: Record<string, StopReason> = { end_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens" };
  return { content, stopReason: stop[body.stop_reason] ?? "other" };
}

function describeError(status: number, body: any): string {
  const detail = body?.error?.message ? `: ${body.error.message}` : "";
  if (status === 401) return "Claude rejected the API key (401). Check it in Settings.";
  if (status === 429) return `Claude rate limit or quota reached (429)${detail}`;
  if (status === 529) return "Claude is overloaded right now (529). Try again shortly.";
  return `Claude API error ${status}${detail}`;
}

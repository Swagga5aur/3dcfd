import {
  ProviderError,
  type AgentMessage, type AgentProvider, type ContentBlock,
  type ProviderRequest, type ProviderResponse, type Transport
} from "../types";

export const CHATGPT_DEFAULT_MODEL = "";

interface ChatGPTOptions { transport: Transport; model?: string; maxTokens?: number; }

/** Responses API adapter. Authentication is handled by the local SIWC runtime. */
export class ChatGPTProvider implements AgentProvider {
  readonly id = "chatgpt";
  readonly label: string;
  constructor(private opts: ChatGPTOptions) {
    this.label = `ChatGPT (${opts.model || "selected account model"})`;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const input: Record<string, unknown>[] = [];
    for (const message of req.messages) input.push(...toInputItems(message));
    const { status, body } = await this.opts.transport({
      path: "/v1/responses",
      body: {
        model: this.opts.model,
        instructions: req.system,
        input,
        max_output_tokens: this.opts.maxTokens ?? 2048,
        tools: req.tools.map(tool => ({
          type: "function", name: tool.name, description: tool.description,
          parameters: tool.inputSchema, strict: false
        })),
        tool_choice: "auto"
      }
    });
    if (status < 200 || status >= 300) {
      const detail = (body as any)?.error?.message || (body as any)?.error || "";
      if (status === 401) throw new ProviderError("ChatGPT session expired or was revoked. Reconnect in Settings.", status);
      if (status === 429) throw new ProviderError(`ChatGPT plan usage limit reached or temporarily rate-limited. Check ChatGPT Settings → Usage. ${detail}`, status);
      throw new ProviderError(`ChatGPT request failed (${status})${detail ? `: ${detail}` : ""}`, status);
    }
    return fromResponse(body);
  }
}

function toInputItems(message: AgentMessage): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (message.role === "user") {
    const text = message.content.filter((b): b is Extract<ContentBlock,{type:"text"}> => b.type === "text").map(b => b.text).join("\n");
    if (text) items.push({ role: "user", content: [{ type: "input_text", text }] });
    for (const block of message.content) if (block.type === "tool_result") {
      items.push({ type: "function_call_output", call_id: block.callId, output: block.content });
    }
    return items;
  }
  const text = message.content.filter((b): b is Extract<ContentBlock,{type:"text"}> => b.type === "text").map(b => b.text).join("\n");
  if (text) items.push({ role: "assistant", content: [{ type: "output_text", text }] });
  for (const block of message.content) if (block.type === "tool_call") {
    items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
  }
  return items;
}

function fromResponse(body: any): ProviderResponse {
  if (!body || !Array.isArray(body.output)) throw new ProviderError("Unexpected response from the ChatGPT Responses API.");
  const content: ContentBlock[] = [];
  for (const item of body.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) if (part.type === "output_text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    } else if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      let input: unknown = {};
      try { input = JSON.parse(item.arguments || "{}"); }
      catch { throw new ProviderError(`ChatGPT returned invalid arguments for tool "${item.name}".`); }
      content.push({ type: "tool_call", id: item.call_id, name: item.name, input });
    }
  }
  const reason = body.incomplete_details?.reason;
  return { content, stopReason: reason === "max_output_tokens" ? "max_tokens" : content.some(b => b.type === "tool_call") ? "tool_use" : body.status === "completed" ? "end_turn" : "other" };
}

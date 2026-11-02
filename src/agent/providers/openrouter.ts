import {
  ProviderError,
  type AgentMessage, type AgentProvider, type ContentBlock,
  type ProviderRequest, type ProviderResponse, type StopReason, type Transport
} from "../types";

export const OPENROUTER_DEFAULT_MODEL = "google/gemma-4-26b-a4b-it:free";

interface OpenRouterOptions {
  transport: Transport;
  model?: string;
  maxTokens?: number;
}

/** OpenAI-compatible Chat Completions adapter for OpenRouter. */
export class OpenRouterProvider implements AgentProvider {
  readonly id = "openrouter";
  readonly label: string;

  constructor(private opts: OpenRouterOptions) {
    this.label = `OpenRouter (${opts.model ?? OPENROUTER_DEFAULT_MODEL})`;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const { status, body } = await this.opts.transport({
      path: "/v1/chat/completions",
      body: {
        model: this.opts.model ?? OPENROUTER_DEFAULT_MODEL,
        max_tokens: this.opts.maxTokens ?? 2048,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.flatMap(toOpenRouterMessages)
        ],
        tools: req.tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
          }
        })),
        tool_choice: "auto"
      }
    });

    if (status < 200 || status >= 300) {
      throw new ProviderError(describeError(status, body), status);
    }
    return fromOpenRouterResponse(body);
  }
}

function toOpenRouterMessages(message: AgentMessage): Record<string, unknown>[] {
  if (message.role === "assistant") {
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map(block => block.text)
      .join("\n");
    const calls = message.content
      .filter((block): block is Extract<ContentBlock, { type: "tool_call" }> => block.type === "tool_call")
      .map(block => ({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
      }));
    return [{
      role: "assistant",
      content: text || null,
      ...(calls.length ? { tool_calls: calls } : {})
    }];
  }

  const messages: Record<string, unknown>[] = [];
  const text = message.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n");
  if (text) messages.push({ role: "user", content: text });

  for (const block of message.content) {
    if (block.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: block.callId,
        content: block.content
      });
    }
  }
  if (messages.length === 0) messages.push({ role: "user", content: "" });
  return messages;
}

function fromOpenRouterResponse(body: any): ProviderResponse {
  const message = body?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new ProviderError("Unexpected response from OpenRouter. The selected model may not support chat completions.");
  }

  const content: ContentBlock[] = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      }
    }
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const id = call?.id;
      const name = call?.function?.name;
      if (typeof id !== "string" || typeof name !== "string") {
        throw new ProviderError("OpenRouter returned a malformed tool call.");
      }
      let input: unknown = {};
      const rawArguments = call.function.arguments;
      if (typeof rawArguments === "string" && rawArguments.trim()) {
        try { input = JSON.parse(rawArguments); }
        catch { throw new ProviderError(`OpenRouter returned invalid JSON arguments for tool "${name}".`); }
      } else if (rawArguments && typeof rawArguments === "object") {
        input = rawArguments;
      }
      content.push({ type: "tool_call", id, name, input });
    }
  }

  const finishReason = body.choices[0].finish_reason;
  const stop: Record<string, StopReason> = {
    stop: "end_turn",
    tool_calls: "tool_use",
    function_call: "tool_use",
    length: "max_tokens"
  };
  return { content, stopReason: stop[finishReason] ?? (content.some(b => b.type === "tool_call") ? "tool_use" : "other") };
}

function describeError(status: number, body: any): string {
  const detail = body?.error?.message ? `: ${body.error.message}` : "";
  if (status === 401) return "OpenRouter rejected the API key (401). Check it in Settings.";
  if (status === 402) return `OpenRouter reports insufficient credits or a payment requirement (402)${detail}`;
  if (status === 404) return `OpenRouter could not find the selected model or endpoint (404)${detail}`;
  if (status === 429) return `OpenRouter rate limit reached (429). Free models have request limits${detail}`;
  return `OpenRouter API error ${status}${detail}`;
}

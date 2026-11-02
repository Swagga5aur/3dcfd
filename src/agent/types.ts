/**
 * Provider-neutral agent types. Nothing in here knows about Claude, OpenAI or
 * any wire format. Provider adapters translate to/from these shapes.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export interface AgentMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** JSON-Schema subset used for tool inputs (see schema.ts for what is validated). */
export interface JsonSchema {
  type: "object" | "number" | "string" | "boolean";
  description?: string;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ProviderRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface ProviderResponse {
  content: ContentBlock[];
  stopReason: StopReason;
}

/** The only thing the rest of the app knows about an AI provider. */
export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

/** Sends a JSON request to a provider endpoint. In the app this is the Rust backend, which adds the API key. */
export type Transport = (request: { path: string; body: unknown }) => Promise<{ status: number; body: unknown }>;

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

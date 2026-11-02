import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioStore, type ModelAsset } from "../src/model/store";
import { AgentManager, type ApprovalRequest } from "../src/agent/agentManager";
import { createDefaultRegistry } from "../src/agent/tools";
import { DEFAULT_PERMISSIONS, assessOperation } from "../src/agent/permissions";
import { ClaudeProvider } from "../src/agent/providers/claude";
import { validate } from "../src/agent/schema";
import { ProviderError, type AgentProvider, type ProviderRequest, type ProviderResponse, type Transport } from "../src/agent/types";

const ASSET: ModelAsset = { name: "dragon.stl", vertices: 300, triangles: 100, baseSize: [10, 20, 30] };
const call = (id: string, name: string, input: unknown): ProviderResponse => ({ content: [{ type: "tool_call", id, name, input }], stopReason: "tool_use" });
const say = (text: string): ProviderResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

/** Plays back scripted responses and records every request it receives. */
function scripted(responses: ProviderResponse[]) {
  const requests: ProviderRequest[] = [];
  const provider: AgentProvider = {
    id: "fake", label: "fake",
    async complete(req) {
      requests.push(structuredClone(req));
      const next = responses.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    }
  };
  return { provider, requests };
}

function setup(responses: ProviderResponse[], approve: boolean | ((r: ApprovalRequest) => boolean) = true, opts: { autoApply?: boolean; maxSteps?: number } = {}) {
  const store = new StudioStore();
  store.loadAsset(ASSET);
  const { provider, requests } = scripted(responses);
  const approvals: ApprovalRequest[] = [];
  const previewsSeen: unknown[] = [];
  const agent = new AgentManager({
    getProvider: () => provider,
    registry: createDefaultRegistry(),
    ctx: { store },
    getPermissions: () => ({ ...DEFAULT_PERMISSIONS, autoApplyLowRisk: opts.autoApply ?? true }),
    requestApproval: async r => { approvals.push(r); previewsSeen.push(store.getState().preview); return typeof approve === "function" ? approve(r) : approve; },
    maxSteps: opts.maxSteps
  });
  return { store, agent, requests, approvals, previewsSeen };
}

// ---------- store ----------
test("store: commit, undo, redo and redo-clearing", () => {
  const s = new StudioStore(); s.loadAsset(ASSET);
  s.commit({ kind: "scale", factor: 2 }, "user");
  s.commit({ kind: "translate", axis: "z", amount: 5 }, "agent");
  assert.deepEqual(s.getState().transform, { position: [0, 0, 5], scale: [2, 2, 2] });
  s.undo();
  assert.deepEqual(s.getState().transform, { position: [0, 0, 0], scale: [2, 2, 2] });
  s.redo();
  assert.deepEqual(s.getState().transform.position, [0, 0, 5]);
  s.undo(); s.commit({ kind: "scale", factor: 0.5, axis: "y" }, "user");
  assert.equal(s.getState().redoStack.length, 0);
  assert.deepEqual(s.getState().transform.scale, [2, 1, 2]);
});

test("store: preview never changes committed state; loading resets history", () => {
  const s = new StudioStore(); s.loadAsset(ASSET);
  s.setPreview({ kind: "scale", factor: 3 });
  assert.deepEqual(s.getState().preview?.scale, [3, 3, 3]);
  assert.deepEqual(s.getState().transform.scale, [1, 1, 1]);
  s.commit({ kind: "scale", factor: 2 }, "user");
  assert.equal(s.getState().preview, null);
  s.loadAsset(ASSET);
  assert.equal(s.getState().undoStack.length, 0);
});

test("store: cannot commit without a model", () => {
  assert.throws(() => new StudioStore().commit({ kind: "scale", factor: 2 }, "user"), /No model/);
});

// ---------- permissions ----------
test("permissions: small changes auto, large ones need approval", () => {
  const s = new StudioStore(); s.loadAsset(ASSET);
  const st = s.getState();
  assert.equal(assessOperation({ kind: "scale", factor: 1.1 }, st, DEFAULT_PERMISSIONS).level, "auto");
  assert.equal(assessOperation({ kind: "scale", factor: 0.9 }, st, DEFAULT_PERMISSIONS).level, "auto");
  assert.equal(assessOperation({ kind: "scale", factor: 2 }, st, DEFAULT_PERMISSIONS).level, "approval");
  assert.equal(assessOperation({ kind: "scale", factor: 0.5 }, st, DEFAULT_PERMISSIONS).level, "approval");
  assert.equal(assessOperation({ kind: "translate", axis: "x", amount: 2 }, st, DEFAULT_PERMISSIONS).level, "auto");   // 2 <= 25% of 30
  assert.equal(assessOperation({ kind: "translate", axis: "x", amount: 20 }, st, DEFAULT_PERMISSIONS).level, "approval");
  assert.equal(assessOperation({ kind: "scale", factor: 1.1 }, st, { ...DEFAULT_PERMISSIONS, autoApplyLowRisk: false }).level, "approval");
});

test("permissions: cumulative drift forces approval even for small steps", () => {
  const s = new StudioStore(); s.loadAsset(ASSET);
  for (let i = 0; i < 6; i++) s.commit({ kind: "scale", factor: 1.25 }, "user"); // 1.25^6 ≈ 3.81
  assert.equal(assessOperation({ kind: "scale", factor: 1.1 }, s.getState(), DEFAULT_PERMISSIONS).level, "approval");
});

// ---------- schema ----------
test("schema: rejects wrong types, ranges, enums and extra fields", () => {
  const schema = createDefaultRegistry().get("transform_model")!.spec.inputSchema;
  assert.deepEqual(validate(schema, { kind: "scale", factor: 1.2 }), []);
  assert.ok(validate(schema, { factor: 1 }).some(e => /kind is required/.test(e)));
  assert.ok(validate(schema, { kind: "rotate" }).some(e => /one of/.test(e)));
  assert.ok(validate(schema, { kind: "scale", factor: 99 }).some(e => /<= 10/.test(e)));
  assert.ok(validate(schema, { kind: "scale", factor: "2" }).length > 0);
  assert.ok(validate(schema, { kind: "scale", factor: NaN }).length > 0);
  assert.ok(validate(schema, { kind: "scale", factor: 1, evil: 1 }).some(e => /not an allowed/.test(e)));
});

// ---------- agent loop ----------
test("loop: read-only tool then final answer; tool_result is sent back", async () => {
  const t = setup([call("c1", "get_model_info", {}), say("It is 10×20×30.")]);
  const out = await t.agent.send("how big is it?");
  assert.equal(out, "It is 10×20×30.");
  const result = t.requests[1].messages.at(-1)!.content[0] as any;
  assert.equal(result.type, "tool_result");
  assert.equal(result.callId, "c1");
  assert.deepEqual(JSON.parse(result.content).size, [10, 20, 30]);
  assert.equal(t.approvals.length, 0);
});

test("loop: small change applies automatically and is attributed to the agent", async () => {
  const t = setup([call("c1", "transform_model", { kind: "scale", factor: 1.1 }), say("Done.")]);
  await t.agent.send("slightly bigger");
  assert.equal(t.approvals.length, 0);
  assert.equal(t.store.getState().undoStack[0].source, "agent");
  assert.ok(Math.abs(t.store.getState().transform.scale[0] - 1.1) < 1e-9);
});

test("loop: large change asks approval, shows preview, applies only if approved", async () => {
  const t = setup([call("c1", "transform_model", { kind: "scale", factor: 2 }), say("Doubled.")], true);
  await t.agent.send("double it");
  assert.equal(t.approvals.length, 1);
  assert.deepEqual((t.previewsSeen[0] as any).scale, [2, 2, 2]);      // preview visible while deciding
  assert.equal(t.store.getState().preview, null);                      // and cleared afterwards
  assert.deepEqual(t.store.getState().transform.scale, [2, 2, 2]);
});

test("loop: rejected change leaves the model untouched and tells the model", async () => {
  const t = setup([call("c1", "transform_model", { kind: "scale", factor: 5 }), say("Okay, not doing that.")], false);
  await t.agent.send("make it huge");
  assert.deepEqual(t.store.getState().transform.scale, [1, 1, 1]);
  assert.equal(t.store.getState().undoStack.length, 0);
  const result = t.requests[1].messages.at(-1)!.content[0] as any;
  assert.equal(result.isError, true);
  assert.match(result.content, /rejected/);
});

test("loop: auto-apply disabled forces approval even for tiny changes", async () => {
  const t = setup([call("c1", "transform_model", { kind: "scale", factor: 1.05 }), say("ok")], true, { autoApply: false });
  await t.agent.send("x");
  assert.equal(t.approvals.length, 1);
});

test("loop: invalid args, unknown tools and cross-field errors never modify the model", async () => {
  const t = setup([
    call("a", "transform_model", { kind: "scale", factor: 1000 }),
    call("b", "delete_everything", {}),
    call("c", "transform_model", { kind: "translate", amount: 3 }),   // axis missing
    say("giving up")
  ]);
  await t.agent.send("x");
  assert.equal(t.store.getState().undoStack.length, 0);
  assert.equal(t.approvals.length, 0);
  const errs = t.requests.slice(1).map(r => (r.messages.at(-1)!.content[0] as any));
  assert.ok(errs.every(e => e.isError));
  assert.match(errs[0].content, /<= 10/);
  assert.match(errs[1].content, /Unknown tool/);
  assert.match(errs[2].content, /axis/);
});

test("loop: undo tool works and is not approval-gated", async () => {
  const t = setup([call("a", "transform_model", { kind: "scale", factor: 1.2 }), call("b", "undo_operation", {}), say("undone")]);
  await t.agent.send("try then undo");
  assert.deepEqual(t.store.getState().transform.scale, [1, 1, 1]);
  assert.equal(t.store.getState().redoStack.length, 1);
});

test("loop: no model loaded gives the model a clear error", async () => {
  const t = setup([call("a", "transform_model", { kind: "scale", factor: 1.1 }), say("need a model")]);
  t.store.loadAsset(ASSET); // then simulate empty project:
  (t.store as any).state = { ...t.store.getState(), asset: null };
  await t.agent.send("x");
  const r = t.requests[1].messages.at(-1)!.content[0] as any;
  assert.match(r.content, /No model/);
});

test("loop: step limit stops a runaway tool loop", async () => {
  const many = Array.from({ length: 10 }, (_, i) => call(`c${i}`, "get_model_info", {}));
  const t = setup(many, true, { maxSteps: 3 });
  const out = await t.agent.send("loop");
  assert.equal(t.requests.length, 3);
  assert.match(out, /too many steps/);
});

test("loop: provider failure rolls back the turn so history stays valid", async () => {
  const t = setup([call("a", "get_model_info", {})]); // second call exhausts the script -> throws
  await assert.rejects(t.agent.send("x"), /script exhausted/);
  assert.equal(t.agent.getHistory().length, 0);
  assert.equal(t.agent.isRunning, false);
});

test("loop: rejects concurrent requests", async () => {
  const t = setup([say("a"), say("b")]);
  const p = t.agent.send("one");
  await assert.rejects(t.agent.send("two"), /already working/);
  await p;
});

test("loop: system prompt reflects project state and tools are advertised", async () => {
  const t = setup([say("hi")]);
  await t.agent.send("hello");
  assert.match(t.requests[0].system, /dragon\.stl/);
  assert.deepEqual(t.requests[0].tools.map(x => x.name).sort(), ["get_model_info", "list_operations", "redo_operation", "transform_model", "undo_operation"]);
});

// ---------- Claude adapter ----------
test("claude: builds a correct Messages request and parses tool_use", async () => {
  let sent: any;
  const transport: Transport = async r => {
    sent = r;
    return { status: 200, body: { stop_reason: "tool_use", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "tu_1", name: "get_model_info", input: {} }, { type: "thinking", thinking: "x" }] } };
  };
  const res = await new ClaudeProvider({ transport, model: "m-1" }).complete({
    system: "sys",
    tools: createDefaultRegistry().specs().slice(0, 1),
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_call", id: "tu_0", name: "get_model_info", input: {} }] },
      { role: "user", content: [{ type: "tool_result", callId: "tu_0", content: "{}", isError: true }] }
    ]
  });
  assert.equal(sent.path, "/v1/messages");
  assert.equal(sent.body.model, "m-1");
  assert.equal(sent.body.system, "sys");
  assert.ok(sent.body.max_tokens > 0);
  assert.equal(sent.body.tools[0].input_schema.type, "object");
  assert.deepEqual(sent.body.messages[1].content[0], { type: "tool_use", id: "tu_0", name: "get_model_info", input: {} });
  assert.deepEqual(sent.body.messages[2].content[0], { type: "tool_result", tool_use_id: "tu_0", content: "{}", is_error: true });
  assert.equal(res.stopReason, "tool_use");
  assert.deepEqual(res.content, [{ type: "text", text: "Checking." }, { type: "tool_call", id: "tu_1", name: "get_model_info", input: {} }]);
});

test("claude: maps HTTP errors to readable ProviderErrors", async () => {
  const mk = (status: number, body: unknown) => new ClaudeProvider({ transport: async () => ({ status, body }) }).complete({ system: "", messages: [], tools: [] });
  await assert.rejects(mk(401, { error: { message: "bad key" } }), (e: any) => e instanceof ProviderError && /API key/.test(e.message) && e.status === 401);
  await assert.rejects(mk(429, { error: { message: "slow down" } }), /rate limit.*slow down/);
  await assert.rejects(mk(500, null), /500/);
  await assert.rejects(mk(200, { nope: true }), /Unexpected response/);
});

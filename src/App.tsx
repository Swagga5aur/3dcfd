import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Viewport from "./viewport/Viewport";
import { StudioStore, boundsFor } from "./model/store";
import { AgentManager, type AgentEvent, type ApprovalRequest } from "./agent/agentManager";
import { createDefaultRegistry } from "./agent/tools";
import { ClaudeProvider } from "./agent/providers/claude";
import { OpenRouterProvider } from "./agent/providers/openrouter";
import { ChatGPTProvider } from "./agent/providers/chatgpt";
import { backend } from "./agent/backend";
import { defaultModelFor, loadSettings, saveSettings, type AppSettings } from "./settings";

type ChatItem = { kind: "user" | "assistant" | "tool" | "error"; text: string };

export default function App() {
  const store = useMemo(() => new StudioStore(), []);
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadRef = useRef<((file: File) => Promise<void>) | null>(null);
  const exporterRef = useRef<{ exportSTL: () => void } | null>(null);
  const settingsRef = useRef<AppSettings>(loadSettings());
  const approvalResolver = useRef<((ok: boolean) => void) | null>(null);

  const [settings, setSettings] = useState(settingsRef.current);
  const [hasKey, setHasKey] = useState(false);
  const [chatGPTConnected, setChatGPTConnected] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [status, setStatus] = useState("Ready — import a model to begin.");
  const [chat, setChat] = useState<ChatItem[]>([{ kind: "assistant", text: "Welcome to AI 3D Studio. Import an STL or GLB, add your AI provider API key in Settings, then describe a change. Currently I can resize and move the whole model; part-level edits, textures and print analysis are not available yet." }]);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { settingsRef.current = settings; saveSettings(settings); }, [settings]);
  useEffect(() => {
    if (settings.provider === "chatgpt") {
      setHasKey(false);
      backend.chatgptStatus().then(s => setChatGPTConnected(s.connected)).catch(() => setChatGPTConnected(false));
    } else {
      setChatGPTConnected(false);
      setHasKey(false);
      backend.hasApiKey(settings.provider).then(setHasKey).catch(() => setHasKey(false));
    }
  }, [settings.provider]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: "end" }); }, [chat, approval]);

  const add = (item: ChatItem) => setChat(c => [...c, item]);

  const agent = useMemo(() => new AgentManager({
    getProvider: () => settingsRef.current.provider === "chatgpt"
      ? new ChatGPTProvider({ transport: backend.transport("chatgpt"), model: settingsRef.current.model })
      : settingsRef.current.provider === "openrouter"
        ? new OpenRouterProvider({ transport: backend.transport("openrouter"), model: settingsRef.current.model })
        : new ClaudeProvider({ transport: backend.transport("anthropic"), model: settingsRef.current.model }),
    registry: createDefaultRegistry(),
    ctx: { store },
    getPermissions: () => settingsRef.current.permissions,
    requestApproval: req => new Promise<boolean>(resolve => { approvalResolver.current = resolve; setApproval(req); }),
    onEvent: (e: AgentEvent) => {
      if (e.type === "assistant_text") add({ kind: "assistant", text: e.text });
      else if (e.type === "tool_call") add({ kind: "tool", text: `⚙ ${e.name}${Object.keys(e.input as object).length ? " " + JSON.stringify(e.input) : ""}` });
      else if (e.type === "tool_result" && !e.ok) add({ kind: "tool", text: `✕ ${e.text}` });
    }
  }), [store]);

  function resolveApproval(ok: boolean) {
    approvalResolver.current?.(ok);
    approvalResolver.current = null;
    setApproval(null);
  }

  async function send() {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt(""); setBusy(true); add({ kind: "user", text });
    setStatus("Assistant is working…");
    try { await agent.send(text); setStatus("Ready."); }
    catch (e) { add({ kind: "error", text: e instanceof Error ? e.message : String(e) }); setStatus("Request failed."); }
    finally { setBusy(false); }
  }

  async function importFile(file?: File) {
    if (!file || !loadRef.current) return;
    try { await loadRef.current(file); agent.reset(); }
    catch (e) { setStatus(e instanceof Error ? e.message : "Import failed."); }
  }

  function saveProject() {
    const s = store.getState();
    const data = JSON.stringify({
      format: "ai-3d-studio-project", version: 2, savedAt: new Date().toISOString(),
      modelName: s.asset?.name ?? "Untitled", transform: s.transform,
      operations: s.undoStack.map(({ label, operation, source, at }) => ({ label, operation, source, at }))
    }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "project.a3d.json"; a.click(); URL.revokeObjectURL(url);
  }

  const asset = state.asset;
  const bounds = asset ? boundsFor(asset, state.transform) : null;
  const connected = settings.provider === "chatgpt" ? chatGPTConnected : hasKey;
  const canChat = connected && !!asset && (settings.provider !== "chatgpt" || !!settings.model);

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">3D</div><div><strong>AI 3D Studio</strong><small>Prototype 0.2</small></div></div>
      <div className="top-actions">
        <button onClick={() => fileRef.current?.click()}>Import model</button>
        <button className="secondary" onClick={() => store.undo()} disabled={!state.undoStack.length || busy}>Undo</button>
        <button className="secondary" onClick={() => store.redo()} disabled={!state.redoStack.length || busy}>Redo</button>
        <button className="secondary" onClick={saveProject} disabled={!asset}>Save project</button>
        <button className="secondary" onClick={() => exporterRef.current?.exportSTL()} disabled={!asset}>Export STL</button>
        <button className="secondary" onClick={() => setShowSettings(true)}>Settings</button>
      </div>
    </header>
    <input ref={fileRef} type="file" accept=".stl,.glb,.gltf" hidden onChange={e => { importFile(e.target.files?.[0]); e.target.value = ""; }} />
    <main className="main-layout">
      <aside className="left-panel panel">
        <div className="panel-heading">PROJECT</div>
        <div className="project-card"><span className="status-dot" /><div><strong>{asset?.name ?? "Untitled project"}</strong><small>{asset ? `${asset.triangles.toLocaleString()} triangles` : "No model loaded"}</small></div></div>
        <div className="panel-heading section-heading">MODEL</div>
        {asset && bounds ? <div className="info-list">
          <div><span>Triangles</span><b>{asset.triangles.toLocaleString()}</b></div>
          <div><span>Size X</span><b>{bounds.size[0].toFixed(2)}</b></div>
          <div><span>Size Y</span><b>{bounds.size[1].toFixed(2)}</b></div>
          <div><span>Size Z</span><b>{bounds.size[2].toFixed(2)}</b></div>
          <div><span>Scale</span><b>{state.transform.scale.map(v => v.toFixed(2)).join(" · ")}</b></div>
        </div> : <p className="muted empty-hint">Import an STL or GLB to inspect its geometry.</p>}
        <div className="panel-heading section-heading">HISTORY</div>
        {state.undoStack.length === 0 ? <p className="muted empty-hint">No operations yet.</p> :
          <ol className="history">{state.undoStack.map(e => <li key={e.id}>{e.label}<small>{e.source === "agent" ? "AI" : "You"}</small></li>)}</ol>}
        <div className="panel-heading section-heading">PLANNED</div>
        <button className="tool-button" disabled>◌ Region selection <span>Later</span></button>
        <button className="tool-button" disabled>▧ Surface textures <span>Later</span></button>
        <button className="tool-button" disabled>◉ Colour & materials <span>Later</span></button>
      </aside>

      <section className="center-panel">
        <div className="viewport-toolbar"><div><strong>3D Viewport</strong><span className="muted"> · Perspective</span></div><div className="view-actions"><span className="live-dot" /> Local workspace</div></div>
        <Viewport store={store} onStatus={setStatus} onExportReady={v => (exporterRef.current = v)} onLoadReady={v => (loadRef.current = v)} />
        <div className="viewport-footer"><span>{status}</span><span>Orbit: drag · Zoom: scroll · Pan: right-drag</span></div>
      </section>

      <aside className="right-panel panel">
        <div className="agent-header"><div><div className="panel-heading">AI ASSISTANT</div><strong>Project agent</strong></div><span className="provider-tag">{connected ? settings.provider.toUpperCase() : settings.provider === "chatgpt" ? "NOT CONNECTED" : "NO KEY"}</span></div>
        <div className="agent-context"><span className="context-icon">✳</span><div><strong>Project context</strong><small>{asset ? `Inspecting ${asset.name}` : "Waiting for a model"}</small></div></div>
        <div className="messages">
          {chat.map((m, i) => m.kind === "tool"
            ? <div key={i} className="tool-line">{m.text}</div>
            : <div key={i} className={`message ${m.kind === "user" ? "user" : "assistant"} ${m.kind === "error" ? "error" : ""}`}>
              <div className="message-role">{m.kind === "user" ? "YOU" : m.kind === "error" ? "ERROR" : "ASSISTANT"}</div><div>{m.text}</div></div>)}
          {approval && <div className="proposal-card">
            <div className="proposal-title">APPROVAL REQUIRED</div>
            <strong>{approval.summary}</strong>
            <ul className="reasons">{approval.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            <p>The viewport shows a preview. Nothing is applied until you approve.</p>
            <div className="proposal-actions"><button onClick={() => resolveApproval(true)}>Approve</button><button className="secondary" onClick={() => resolveApproval(false)}>Reject</button></div>
          </div>}
          <div ref={messagesEnd} />
        </div>
        <div className="composer">
          <div className="composer-hint">{!connected ? settings.provider === "chatgpt" ? "Connect ChatGPT in Settings and keep the local runtime running." : "Add your API key in Settings to enable the assistant." : !asset ? "Import a model first." : "e.g. “make it 10% larger” or “move it up by 5”"}</div>
          <textarea value={prompt} disabled={!canChat} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Describe a change to your model..." />
          <div className="composer-bottom"><span>Large changes need approval</span>
            {busy ? <button className="secondary" onClick={() => { agent.cancel(); resolveApproval(false); }}>Cancel</button>
              : <button onClick={send} disabled={!canChat || !prompt.trim()}>Send ↑</button>}</div>
        </div>
      </aside>
    </main>
    <footer className="statusbar"><span>● Prototype 0.2</span><span>{status}</span><span>{backend.secureStorage() ? null : <a href={releasesUrl()} target="_blank" rel="noreferrer">Download for Windows</a>} AI provider: {connected ? `${settings.provider === "openrouter" ? "OpenRouter" : settings.provider === "chatgpt" ? "ChatGPT plan" : "Claude"} (${settings.model})` : "not connected"}</span></footer>
    {showSettings && <SettingsDialog settings={settings} hasKey={hasKey} chatGPTConnected={chatGPTConnected} onChange={setSettings} onKeyChange={setHasKey} onChatGPTChange={setChatGPTConnected} onClose={() => setShowSettings(false)} />}
  </div>;
}

/** On GitHub Pages (<user>.github.io/<repo>/) the releases page can be derived from the address. */
function releasesUrl() {
  const { hostname, pathname } = window.location;
  const repo = pathname.split("/")[1];
  return hostname.endsWith(".github.io") && repo ? `https://github.com/${hostname.split(".")[0]}/${repo}/releases/latest` : "#";
}

function SettingsDialog(props: { settings: AppSettings; hasKey: boolean; chatGPTConnected: boolean; onChange: (s: AppSettings) => void; onKeyChange: (b: boolean) => void; onChatGPTChange: (b: boolean) => void; onClose: () => void }) {
  const { settings, hasKey } = props;
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const [checking, setChecking] = useState(false);
  const [chatGPTModels, setChatGPTModels] = useState<Array<{ id: string; name: string }>>([]);
  const secure = backend.secureStorage();

  useEffect(() => {
    if (settings.provider === "chatgpt" && props.chatGPTConnected) {
      backend.chatgptModels().then(models => {
        setChatGPTModels(models);
        if (models.length && !models.some(m => m.id === settings.model)) {
          props.onChange({ ...settings, model: models[0].id });
        }
      }).catch(e => setMsg(String(e)));
    }
  }, [settings.provider, props.chatGPTConnected]);

  async function refreshChatGPT() {
    setChecking(true);
    try { const s = await backend.chatgptStatus(); props.onChatGPTChange(s.connected); setMsg(s.connected ? `Connected to ChatGPT${s.email ? ` as ${s.email}` : ""}.` : "ChatGPT is not connected yet."); }
    catch (e) { props.onChatGPTChange(false); setMsg(String(e)); }
    finally { setChecking(false); }
  }
  async function connectChatGPT() {
    try { await backend.connectChatGPT(); setMsg("Sign-in opened in your browser. Complete the permission step, then return here and check the connection."); }
    catch (e) { setMsg(String(e)); }
  }
  async function disconnectChatGPT() {
    try { await backend.disconnectChatGPT(); props.onChatGPTChange(false); setMsg("ChatGPT disconnected."); }
    catch (e) { setMsg(String(e)); }
  }

  async function saveKey() {
    try { await backend.setApiKey(settings.provider, key); setKey(""); props.onKeyChange(true); setMsg(secure ? "Key saved to Windows Credential Manager." : "Key held in memory for this tab only."); }
    catch (e) { setMsg(String(e)); }
  }
  async function removeKey() {
    try { await backend.deleteApiKey(settings.provider); props.onKeyChange(false); setMsg("Key removed."); }
    catch (e) { setMsg(String(e)); }
  }

  return <div className="modal-backdrop" onClick={props.onClose}><div className="modal" onClick={e => e.stopPropagation()}>
    <h3>Settings</h3>
    {settings.provider === "chatgpt" ? <div className="field">
      <span>ChatGPT plan connection {props.chatGPTConnected && <b className="ok">● connected</b>}</span>
      <p className="muted">Sign in with ChatGPT to use eligible requests through your plan. Your credentials stay on this computer in the local runtime; they are not stored in this browser.</p>
      <div className="modal-row"><button onClick={connectChatGPT} disabled={props.chatGPTConnected}>Continue with ChatGPT</button><button className="secondary" onClick={refreshChatGPT} disabled={checking}>{checking ? "Checking…" : "Check connection"}</button><button className="secondary" onClick={disconnectChatGPT} disabled={!props.chatGPTConnected}>Disconnect</button></div>
      <p className="muted">Keep the local runtime running while using the web app. ChatGPT plan limits apply and may be shared with other connected apps.</p>
    </div> : <>
    <label className="field"><span>{settings.provider === "openrouter" ? "OpenRouter API key" : "Claude API key"} {hasKey && <b className="ok">● saved</b>}</span>
      <input type="password" autoComplete="off" value={key} placeholder={hasKey ? "Saved — enter a new key to replace it" : settings.provider === "openrouter" ? "sk-or-v1-…" : "sk-ant-…"} onChange={e => setKey(e.target.value)} />
    </label>
    <div className="modal-row"><button onClick={saveKey} disabled={!key.trim()}>Save key</button><button className="secondary" onClick={removeKey} disabled={!hasKey}>Remove key</button></div>
    {secure
      ? <p className="muted">Stored in the OS credential store and used only by the app's backend. It is never saved in project files or browser storage.</p>
      : <p className="muted">Web version: your key is kept in memory only, sent directly from this browser to {settings.provider === "openrouter" ? "OpenRouter" : "Anthropic"}, and forgotten when you reload. Never commit it to GitHub.</p>}
    <p className="muted">API usage and free-model limits are controlled by your selected provider. Free model availability and rate limits can change.</p>
    </>}
    <label className="field"><span>AI provider</span>
      <select value={settings.provider} onChange={e => { const provider = e.target.value as AppSettings["provider"]; props.onChange({ ...settings, provider, model: defaultModelFor(provider) }); }}>
        <option value="chatgpt">ChatGPT plan (local runtime)</option>
        <option value="openrouter">OpenRouter (free models available)</option>
        <option value="anthropic">Claude (Anthropic)</option>
      </select>
    </label>
    {settings.provider === "chatgpt" ? <label className="field"><span>ChatGPT model</span>
      <select value={settings.model} disabled={!chatGPTModels.length} onChange={e => props.onChange({ ...settings, model: e.target.value })}>
        {!chatGPTModels.length && <option value="">Connect ChatGPT to load available models</option>}
        {chatGPTModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label> : <label className="field"><span>Model ID</span><input value={settings.model} onChange={e => props.onChange({ ...settings, model: e.target.value })} /></label>}
    <label className="check"><input type="checkbox" checked={settings.permissions.autoApplyLowRisk}
      onChange={e => props.onChange({ ...settings, permissions: { ...settings.permissions, autoApplyLowRisk: e.target.checked } })} />
      Let the assistant apply small changes without asking (large changes always need approval)</label>
    {msg && <p className="muted">{msg}</p>}
    <div className="modal-row"><button className="secondary" onClick={props.onClose}>Close</button></div>
  </div></div>;
}

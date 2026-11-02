
# 3D CFD Studio — Prototype 0.2

A lean Windows desktop starter for AI-assisted 3D model creation and modification.

## Included in this prototype

- Tauri 2 + React + TypeScript desktop shell
- Three.js viewport
- Import STL and GLB/GLTF
- Export STL
- Basic model inspection
- Scale and translation operations
- **AI agent** (Claude via the Anthropic API) that inspects the model and acts only through validated tools
- Provider-independent `AgentProvider` interface; Claude is the first adapter
- API key stored in Windows Credential Manager via Rust; never in the webview, project files or browser storage
- Hybrid permissions: small changes auto-apply, larger ones show a preview and need approval
- Real undo/redo backed by an operation ledger
- Save a lightweight project file (`.a3d.json`, transform + operation list)
- Unit tests for the agent logic (`npm test`)

## Important status

This is a foundation, not a finished product. The agent logic is unit-tested; the Rust backend and UI have **not yet been compiled or run on Windows** (see `docs/IMPLEMENTATION_NOTES.md`). You need your own Anthropic API key (API billing is separate from a Claude subscription). The assistant can currently only resize/move the whole model.

The first version applies object-level transforms in the viewport after approval. Project saving currently stores metadata and transform state, not the imported geometry asset. True undo/redo, remeshing, sculpting, support analysis, texture displacement, multicolour 3MF export, and image/text-to-3D generation are not implemented yet.

## Run in the browser (GitHub Pages)

The app also runs as a static web page, like ScanRuler. The workflow `.github/workflows/pages.yml` tests, builds and deploys it on every push to `main`.

One-time setup: push this folder to a GitHub repo → **Settings → Pages → Source: GitHub Actions**. The site appears at `https://<user>.github.io/<repo>/`.

Web vs desktop:

| | Desktop (Tauri) | Web (Pages) |
| --- | --- | --- |
| API key | Windows Credential Manager, used only in Rust | Held in page memory, lost on reload |
| API calls | Via Rust, fixed host allowlist | Direct from browser to Anthropic |
| Everything else | Same | Same |

In the web version the key is visible to the page's own JavaScript, so use a key with a spend limit and only the official site you deployed. Do not put a key in the repo or in build settings: it would be public.

## Download the Windows app

Push a version tag and GitHub builds the installer for you (no local Rust setup needed):

```bash
git tag v0.2.1 && git push origin v0.2.1
```

`.github/workflows/desktop.yml` creates a **draft** release with the `.exe` installer; open the repo's **Releases** page, check it, and click Publish. Every push to `main` also builds the installer as a downloadable workflow artifact. The web app shows a "Download for Windows" link in its footer pointing at the latest release.

The installer is **not code-signed**, so Windows SmartScreen will warn on first run (More info → Run anyway). Signing needs a paid certificate and can be added later.

## Requirements (only for building locally)

- Windows 10/11
- Node.js 20.19+ or 22.12+
- Rust stable toolchain
- Microsoft C++ Build Tools (Visual Studio Build Tools)
- WebView2 Runtime

See Tauri's Windows prerequisites: https://v2.tauri.app/start/prerequisites/

## Run in development

Open PowerShell in this directory:

```powershell
npm install
npm run tauri dev
```

## Build a Windows installer

```powershell
npm run tauri build
```

The installer/bundle output is created under `src-tauri/target/release/bundle/`.

## Current workflow

1. Import an STL or GLB model.
2. Enter a request such as:
   - “make it 10% larger”
   - “move it up by 5”
   - “double its width”
3. The assistant inspects the model and calls tools. Small changes apply immediately; larger ones show a preview and wait for **Approve** / **Reject**.
4. Use Undo/Redo (toolbar) to reverse any operation.
5. Add your API key first: **Settings → Claude API key**.
6. Save project to `.a3d.json`; export the current mesh to STL.

Units are whatever units the imported model uses. STL files do not encode units; this prototype assumes millimetres for display only if the source model was authored that way.

## Project layout

```text
src/                 React UI and Three.js viewport
src/agent/            Agent loop, tools, permissions, provider adapters
src/model/            Model store and operation ledger
test/                 Unit tests (npm test)
src-tauri/            Tauri desktop application shell
```

## Next implementation milestones

1. Build/run on Windows; persist mesh + history in the project file.
2. Add robust mesh operations using Manifold-3D.
4. Add region selection and texture/displacement layers.
5. Add colour painting and 3MF material/filament handling.
6. Add FDM/resin printability analysis.
7. Add image-to-3D and text-to-3D provider adapters.

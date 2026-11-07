# AI 3D Studio local runtime

This small Node.js process lets the GitHub Pages frontend use **Sign in with ChatGPT** without putting OAuth tokens in browser storage. It runs on Windows, Linux, and macOS and listens only on loopback.

## Requirements

- Node.js 20.19 or newer
- A ChatGPT account eligible for ChatGPT plan usage in open-source apps
- Internet access for sign-in and model requests

## Start it

From this directory:

```sh
npm install
npm start
```

Keep the terminal running. The runtime listens at `http://127.0.0.1:43127`. Open the deployed AI 3D Studio page and connect ChatGPT in Settings.

On first connection, the system browser opens an OpenAI authorization page. Review the requested permissions and approve ChatGPT plan usage. The app does not receive your ChatGPT password or access to your ChatGPT conversations.

## Credential handling

OAuth access, refresh, and ID tokens are stored by the local runtime, not in the web page. The runtime writes its config under:

- Windows: `%APPDATA%/AI 3D Studio/`
- Linux/macOS: `$XDG_CONFIG_HOME/ai-3d-studio/` or `~/.config/ai-3d-studio/`

On Unix, the directory is mode 0700 and credential files are mode 0600. On Windows, storage is limited to the current user's AppData directory. Disconnecting in Settings attempts to revoke the renewable session before deleting the local credentials.

The runtime binds only to `127.0.0.1` and accepts browser requests only from the published GitHub Pages origin and local development origins. Do not expose this port to your network.

## Usage and limits

Requests use the official Responses API with `store: false` and streaming enabled. ChatGPT plan usage is subject to the limits and eligibility shown in ChatGPT Settings → Usage. This is not unlimited API access, and the allowance may be shared with other apps using your plan.

OpenAI's open-source integration documentation: https://developers.openai.com/siwc/token-sharing-open-source

//! Secure AI backend: API keys live in the OS credential store (Windows
//! Credential Manager) and are attached to requests here. The webview can
//! store/delete a key and make requests, but can never read a key back.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const SERVICE: &str = "ai-3d-studio";

#[derive(Clone, Copy)]
enum AuthScheme {
    Anthropic,
    Bearer,
}

/// Fixed endpoint + auth scheme per provider. A compromised webview cannot use
/// this command to send a stored key to an arbitrary host.
struct ProviderConfig {
    base_url: &'static str,
    auth: AuthScheme,
}

fn provider_config(provider: &str) -> Result<ProviderConfig, String> {
    match provider {
        "anthropic" => Ok(ProviderConfig {
            base_url: "https://api.anthropic.com",
            auth: AuthScheme::Anthropic,
        }),
        "openrouter" => Ok(ProviderConfig {
            base_url: "https://openrouter.ai/api",
            auth: AuthScheme::Bearer,
        }),
        other => Err(format!("Unknown AI provider: {other}")),
    }
}

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    provider_config(provider)?;
    keyring::Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    match entry(&provider)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is empty.".into());
    }
    entry(&provider)?.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Serialize)]
pub struct AiResponse {
    status: u16,
    body: String,
}

#[tauri::command]
pub async fn ai_request(provider: String, path: String, body: Value) -> Result<AiResponse, String> {
    let cfg = provider_config(&provider)?;
    if !path.starts_with("/v1/") || path.contains("..") || path.contains("://") {
        return Err("Invalid API path.".into());
    }
    let key = entry(&provider)?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "No API key saved. Add one in Settings.".to_string(),
        other => other.to_string(),
    })?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = client
        .post(format!("{}{}", cfg.base_url, path))
        .json(&body);
    request = match cfg.auth {
        AuthScheme::Anthropic => request
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        AuthScheme::Bearer => request.bearer_auth(key),
    };

    let resp = request
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(AiResponse { status, body })
}

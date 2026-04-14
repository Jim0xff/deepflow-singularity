export async function createGenerateVideoDraft({
  baseUrl,
  agentApiToken,
  callback,
  source,
  script,
  configDefaults,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      status: 500,
      draftToken: null,
      openUrl: null,
      expiresAt: null,
      error: 'fetch is not available',
    };
  }

  const body = {
    source,
    callback,
  };
  if (script) {
    body.script = script;
  }
  if (configDefaults) {
    body.config_defaults = configDefaults;
  }

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/agent/drafts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        draftToken: null,
        openUrl: null,
        expiresAt: null,
        error: payload?.error || `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      status: response.status,
      draftToken: payload?.draft_token || null,
      openUrl: payload?.open_url || null,
      expiresAt: payload?.expires_at || null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      draftToken: null,
      openUrl: null,
      expiresAt: null,
      error: error?.message || String(error),
    };
  }
}

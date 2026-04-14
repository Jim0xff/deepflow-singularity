import fs from 'node:fs/promises';

function normalizeScriptSource(scriptSource = {}) {
  const rawType = typeof scriptSource.type === 'string' ? scriptSource.type.trim() : '';
  const rawValue = typeof scriptSource.value === 'string' ? scriptSource.value.trim() : '';

  if (!rawValue) {
    return {
      type: null,
      value: null,
    };
  }

  if (rawType === 'file' || rawType === 'url') {
    return {
      type: rawType,
      value: rawValue,
    };
  }

  if (/^https?:\/\//i.test(rawValue)) {
    return {
      type: 'url',
      value: rawValue,
    };
  }

  return {
    type: 'file',
    value: rawValue,
  };
}

export async function loadScriptSource({
  scriptSource = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalized = normalizeScriptSource(scriptSource);
  if (!normalized.type || !normalized.value) {
    return {
      loaded: false,
      sourceType: null,
      sourceValue: null,
      script: null,
      error: null,
    };
  }

  if (normalized.type === 'file') {
    try {
      const script = await fs.readFile(normalized.value, 'utf8');
      return {
        loaded: true,
        sourceType: 'file',
        sourceValue: normalized.value,
        script,
        error: null,
      };
    } catch (error) {
      return {
        loaded: false,
        sourceType: 'file',
        sourceValue: normalized.value,
        script: null,
        error: error?.message || String(error),
      };
    }
  }

  try {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }
    const response = await fetchImpl(normalized.value);
    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status || 500}`);
    }
    const script = await response.text();
    return {
      loaded: true,
      sourceType: 'url',
      sourceValue: normalized.value,
      script,
      error: null,
    };
  } catch (error) {
    return {
      loaded: false,
      sourceType: 'url',
      sourceValue: normalized.value,
      script: null,
      error: error?.message || String(error),
    };
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonObject(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeJsonObject(filePath, value) {
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function loadDraftStore({
  draftsFile,
}) {
  return readJsonObject(draftsFile);
}

export async function saveDraftContext({
  draftsFile,
  record,
}) {
  const store = await readJsonObject(draftsFile);
  store[record.draft_token] = record;
  await writeJsonObject(draftsFile, store);
  return record;
}

export async function getDraftContext({
  draftsFile,
  draftToken,
}) {
  const store = await readJsonObject(draftsFile);
  return store[draftToken] || null;
}

export async function updateDraftContext({
  draftsFile,
  draftToken,
  patch,
}) {
  const store = await readJsonObject(draftsFile);
  if (!store[draftToken]) {
    return null;
  }
  store[draftToken] = {
    ...store[draftToken],
    ...patch,
  };
  await writeJsonObject(draftsFile, store);
  return store[draftToken];
}

export async function appendCallbackLog({
  callbackLogFile,
  entry,
}) {
  await ensureParentDir(callbackLogFile);
  await fs.appendFile(callbackLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

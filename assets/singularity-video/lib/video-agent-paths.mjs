import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');

export function getWorkspaceRoot() {
  return workspaceRoot;
}

export function getVideoAgentPaths() {
  return {
    workspaceRoot,
    configFile: path.join(workspaceRoot, 'config', 'video-agent-config.json'),
    draftsFile: path.join(workspaceRoot, 'drafts.json'),
    callbackLogFile: path.join(workspaceRoot, 'runtime', 'callback-log.jsonl'),
  };
}

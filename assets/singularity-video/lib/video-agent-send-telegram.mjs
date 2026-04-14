import { spawn } from 'node:child_process';

function execFile(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || `Command failed with exit code ${code}`));
    });
  });
}

export async function sendTelegramMessage({
  accountId,
  chatId,
  message,
  replyToMessageId = null,
}) {
  const args = [
    'message',
    'send',
    '--channel',
    'telegram',
    '--account',
    accountId,
    '--target',
    String(chatId),
    '--message',
    message,
    '--json',
  ];

  if (replyToMessageId) {
    args.push('--reply-to', String(replyToMessageId));
  }

  const { stdout } = await execFile('openclaw', args);
  const start = stdout.indexOf('{');
  const payload = start >= 0 ? stdout.slice(start) : stdout;
  return JSON.parse(payload);
}

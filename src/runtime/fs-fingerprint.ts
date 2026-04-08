import { promises as fs } from "node:fs";
import { join } from "node:path";

export async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

export async function directoryFingerprint(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const rootStat = await statOrNull(root);
  if (!rootStat?.isDirectory()) {
    return map;
  }

  await walkDirectory(root, async (entryPath) => {
    const stat = await fs.stat(entryPath);
    const relative = normalizeForUrl(entryPath.slice(root.length + 1));
    if (stat.isDirectory()) {
      map.set(`${relative}/`, "dir");
      return;
    }
    map.set(relative, `${stat.size}:${Math.trunc(stat.mtimeMs)}`);
  });

  return map;
}

export function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false;
    }
  }

  return true;
}

async function walkDirectory(root: string, onEntry: (entryPath: string) => Promise<void>): Promise<void> {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      await onEntry(fullPath);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
}

function normalizeForUrl(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

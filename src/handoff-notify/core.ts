import { join, resolve } from "node:path";

export type HandoffParsedEvent = {
  projectId: string;
  relativePath: string;
  agentId: string;
};

export type OwnerNotifyParsedEvent = {
  projectId: string;
  relativePath: string;
  actionType: "status_updated" | "demo_updated";
};

const handoffTargets = new Set([
  "02_handoff/frontend_task.md",
  "02_handoff/backend_task.md",
  "02_handoff/nodejs_task.md",
  "03_receipts/frontend_receipt.md",
  "03_receipts/backend_receipt.md",
  "03_receipts/nodejs_receipt.md",
]);

const ownerNotifyTargets = new Map<string, OwnerNotifyParsedEvent["actionType"]>([
  ["00_meta/project_status.md", "status_updated"],
  ["05_delivery/current_demo.md", "demo_updated"],
]);

export function parseHandoffFile(changedPath: string, docsRoot: string): HandoffParsedEvent | null {
  const parsedPath = parseProjectDocPath(changedPath, docsRoot);
  if (!parsedPath) {
    return null;
  }

  const { projectId, relativePath } = parsedPath;
  if (!handoffTargets.has(relativePath)) {
    return null;
  }

  const fileName = relativePath.split("/").pop() ?? "";
  const agentId = resolveAgentIdForHandoffFile(fileName);
  if (!agentId) {
    return null;
  }

  return {
    projectId,
    relativePath,
    agentId,
  };
}

export function parseOwnerNotifyFile(changedPath: string, docsRoot: string): OwnerNotifyParsedEvent | null {
  const parsedPath = parseProjectDocPath(changedPath, docsRoot);
  if (!parsedPath) {
    return null;
  }

  const actionType = ownerNotifyTargets.get(parsedPath.relativePath);
  if (!actionType) {
    return null;
  }

  return {
    ...parsedPath,
    actionType,
  };
}

function parseProjectDocPath(changedPath: string, docsRoot: string): { projectId: string; relativePath: string } | null {
  const docsProjectsRoot = normalizeForUrl(join(resolve(docsRoot), "projects"));
  const normalizedPath = normalizeForUrl(resolve(changedPath));

  if (!normalizedPath.startsWith(`${docsProjectsRoot}/`)) {
    return null;
  }

  const relativeFromProjectsRoot = normalizedPath.slice(docsProjectsRoot.length + 1);
  const segments = relativeFromProjectsRoot.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 3) {
    return null;
  }

  const projectId = normalizeProjectCode(segments[0]);
  if (!projectId) {
    return null;
  }

  const relativePath = `${segments[1]}/${segments[2]}`;

  return {
    projectId,
    relativePath,
  };
}

export function resolveAgentIdForHandoffFile(fileName: string): string | null {
  if (fileName === "backend_task.md") {
    return "backend-developer";
  }
  if (fileName === "nodejs_task.md") {
    return "nodejs-developer";
  }
  if (fileName === "frontend_task.md") {
    return "frontend-developer";
  }
  if (
    fileName === "backend_receipt.md"
    || fileName === "frontend_receipt.md"
    || fileName === "nodejs_receipt.md"
  ) {
    return "product-designer";
  }
  return null;
}

export function buildHandoffSessionId(projectId: string, agentId: string): string {
  const safeProject = sanitizeSessionIdComponent(projectId);
  const safeAgent = sanitizeSessionIdComponent(agentId);
  return `handoff-${safeProject}-${safeAgent}`;
}

export function sanitizeSessionIdComponent(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return cleaned || "unknown";
}

export function selectBindingIdForProject(bindings: Record<string, unknown>, projectId: string): string | null {
  const candidates = Object.entries(bindings)
    .filter(([bindingId, boundProject]) => isValidBindingId(bindingId) && boundProject === projectId)
    .map(([bindingId]) => bindingId)
    .sort((a, b) => {
      const aPriority = a.startsWith("tg:") ? 0 : 1;
      const bPriority = b.startsWith("tg:") ? 0 : 1;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return a.localeCompare(b);
    });

  return candidates[0] ?? null;
}

export function isValidBindingId(bindingId: string): boolean {
  return /^tg:-?[0-9]+$|^http:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bindingId);
}

function normalizeForUrl(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeProjectCode(value: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return null;
  }
  return value;
}

import express, { type NextFunction, type Request, type Response } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";

type CreateAppOptions = {
  docsRoot: string;
  openclawGatewayUrl: string;
  docsAuthToken: string;
  docsProjectAuthFileName: string;
};

export function createApp(options: CreateAppOptions): express.Application {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/openclaw-ready", async (_req, res) => {
    if (await isGatewayHealthy(options.openclawGatewayUrl)) {
      res.json({ ready: true });
      return;
    }

    res.status(503).json({ ready: false });
  });

  app.get("/openclaw", (req, res) => {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(308, `/openclaw/${query}`);
  });

  app.use(
    "/openclaw",
    createProxyMiddleware({
      target: options.openclawGatewayUrl,
      changeOrigin: true,
      ws: true,
      pathRewrite: { "^/openclaw": "" },
    }),
  );

  app.get("/login", (req, res) => {
    const nextPath = normalizeNext((req.query.next as string | undefined) ?? "/docs");
    const projectCode =
      normalizeProjectCode((req.query.project as string | undefined) ?? "") ?? inferProjectCodeFromNextPath(nextPath);
    if (!projectCode) {
      res.status(400).send("Project-scoped docs auth requires a project path under /docs/projects/<project-code>/...");
      return;
    }
    const error = req.query.error === "1";
    res.type("html").send(renderLoginPage(nextPath, projectCode, error, options.docsAuthToken));
  });

  app.post("/login", async (req, res, next) => {
    try {
      const providedToken = String(req.body.token ?? "");
      const nextPath = normalizeNext(String(req.body.next ?? "/docs"));
      const projectCode = normalizeProjectCode(String(req.body.project ?? "")) ?? inferProjectCodeFromNextPath(nextPath);
      if (!projectCode) {
        res.status(400).send("Project-scoped docs auth requires a project path under /docs/projects/<project-code>/...");
        return;
      }

      const auth = await readProjectAuth(projectCode, options.docsRoot, options.docsProjectAuthFileName);
      const projectPassword = auth?.password ?? null;
      if (!projectPassword && !options.docsAuthToken) {
        res.status(403).send("Project password is not initialized. Run /bind <project-code> first.");
        return;
      }

      if (!isAllowedDocsToken(providedToken, projectPassword, options.docsAuthToken)) {
        res.redirect(`/login?next=${encodeURIComponent(nextPath)}&project=${encodeURIComponent(projectCode)}&error=1`);
        return;
      }

      res.setHeader("Set-Cookie", buildAuthCookie(projectCode, providedToken));
      res.redirect(nextPath);
    } catch (error) {
      next(error);
    }
  });

  app.use("/docs", (req, res, next) => {
    void authorizeDocsRequest(req, res, next, options);
  });

  app.get("/docs", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");
      const absolutePath = resolveDocsPath(relativePath, options.docsRoot);
      const stat = await fs.stat(absolutePath);

      if (stat.isDirectory()) {
        res.type("html").send(await renderDocsDirectory(relativePath, absolutePath));
        return;
      }

      res.redirect(`/docs/view?path=${encodeURIComponent(normalizeForUrl(relativePath))}`);
    } catch (error) {
      next(error);
    }
  });

  app.get("/docs/view", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");
      const absolutePath = resolveDocsPath(relativePath, options.docsRoot);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        res.status(400).send("Not a file");
        return;
      }
      res.type(contentTypeForExtension(extname(absolutePath)));
      res.sendFile(absolutePath);
    } catch (error) {
      next(error);
    }
  });

  app.get("/docs/download", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");
      const absolutePath = resolveDocsPath(relativePath, options.docsRoot);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        res.status(400).send("Not a file");
        return;
      }
      res.download(absolutePath, basename(absolutePath));
    } catch (error) {
      next(error);
    }
  });

  app.get("/docs/*", async (req, res, next) => {
    try {
      const wildcardPath = (req.params as Record<string, string>)["0"] ?? "";
      const relativePath = decodeURIComponent(wildcardPath);
      const absolutePath = resolveDocsPath(relativePath, options.docsRoot);
      const stat = await fs.stat(absolutePath);

      if (stat.isDirectory()) {
        res.type("html").send(await renderDocsDirectory(relativePath, absolutePath));
        return;
      }

      if (stat.isFile()) {
        res.type(contentTypeForExtension(extname(absolutePath)));
        res.sendFile(absolutePath);
        return;
      }

      res.status(404).send("Not found");
    } catch (error) {
      next(error);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "Unexpected error";
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  return app;
}

async function isGatewayHealthy(openclawGatewayUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${openclawGatewayUrl.replace(/\/$/, "")}/health`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

async function renderDocsDirectory(relativePath: string, absolutePath: string): Promise<string> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const rendered = entries
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const childRelativePath = normalizeForUrl(join(relativePath, entry.name));
      if (entry.isDirectory()) {
        return `<li>📁 <a href="${docsPathToUrl(childRelativePath)}">${escapeHtml(entry.name)}/</a></li>`;
      }
      return `<li>📄 ${escapeHtml(entry.name)} [<a href="${docsPathToUrl(
        childRelativePath,
      )}">open</a>] [<a href="/docs/download?path=${encodeURIComponent(childRelativePath)}">download</a>]</li>`;
    });

  const normalizedRelativePath = normalizeForUrl(relativePath);
  const parentLink = normalizedRelativePath
    ? `<p><a href="${docsPathToUrl(normalizeForUrl(dirname(normalizedRelativePath)))}">⬅ Back</a></p>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>Docs</title></head><body><h1>Docs: /${escapeHtml(
    normalizedRelativePath,
  )}</h1>${parentLink}<ul>${rendered.join("")}</ul></body></html>`;
}

function docsPathToUrl(relativePath: string): string {
  const normalized = normalizeForUrl(relativePath);
  if (!normalized) {
    return "/docs";
  }
  const encodedPath = normalized
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/docs/${encodedPath}`;
}

function resolveDocsPath(relativePath: string, docsRoot: string): string {
  const normalizedRelative = normalizeForPath(relativePath);
  const absolute = resolve(docsRoot, normalizedRelative);
  if (!isWithinRoot(absolute, docsRoot)) {
    throw new Error("Path is outside docs root");
  }
  return absolute;
}

function isWithinRoot(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function normalizeForUrl(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeForPath(value: string): string {
  const cleaned = normalize(value).replace(/^([/\\])+/, "");
  return cleaned === "." ? "" : cleaned;
}

function stripTokenQuery(originalUrl: string): string {
  const parsed = new URL(originalUrl, "http://localhost");
  parsed.searchParams.delete("token");
  return `${parsed.pathname}${parsed.search}`;
}

function buildAuthCookie(projectCode: string, value: string): string {
  const key = projectCookieName(projectCode);
  return `${key}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
}

function parseCookie(cookieHeader: string, key: string): string | null {
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey !== key) {
      continue;
    }
    return decodeURIComponent(rest.join("="));
  }
  return null;
}

function normalizeNext(input: string): string {
  if (!input.startsWith("/")) {
    return "/docs";
  }
  if (input.startsWith("//")) {
    return "/docs";
  }
  return input;
}

function renderLoginPage(nextPath: string, projectCode: string, hasError: boolean, docsAuthToken: string): string {
  const tokenHint = docsAuthToken
    ? "Enter project password or global docs token to continue."
    : "Enter project password to continue.";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Docs Login</title>
    <style>
      body { font-family: sans-serif; max-width: 420px; margin: 40px auto; padding: 0 12px; }
      input, button { width: 100%; padding: 10px; margin-top: 8px; }
      .error { color: #b42318; margin-top: 8px; }
    </style>
  </head>
  <body>
    <h1>Docs Login</h1>
    <p>Project: <strong>${escapeHtml(projectCode)}</strong></p>
    <p>${escapeHtml(tokenHint)}</p>
    ${hasError ? '<p class="error">Invalid password or token</p>' : ""}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}" />
      <input type="hidden" name="project" value="${escapeHtml(projectCode)}" />
      <input type="password" name="token" placeholder="Project password or global token" required />
      <button type="submit">Login</button>
    </form>
  </body>
</html>`;
}

function contentTypeForExtension(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === ".md") {
    return "text/markdown; charset=utf-8";
  }
  if (ext === ".txt" || ext === ".log") {
    return "text/plain; charset=utf-8";
  }
  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  return "application/octet-stream";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeProjectCode(value: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return null;
  }
  return value;
}

function extractProjectCodeFromDocsRelativePath(value: string): string | null {
  const normalized = normalizeForPath(value);
  if (!normalized) {
    return null;
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[0] !== "projects") {
    return null;
  }
  return normalizeProjectCode(segments[1]);
}

function extractProjectCodeFromDocsRequest(req: Request): string | null {
  const parsed = new URL(req.originalUrl, "http://localhost");
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith("/docs/projects/")) {
    return extractProjectCodeFromDocsRelativePath(pathname.slice("/docs/".length));
  }

  const queryPath = parsed.searchParams.get("path") ?? "";
  return extractProjectCodeFromDocsRelativePath(queryPath);
}

function inferProjectCodeFromNextPath(nextPath: string): string | null {
  const parsed = new URL(nextPath, "http://localhost");
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith("/docs/projects/")) {
    return extractProjectCodeFromDocsRelativePath(pathname.slice("/docs/".length));
  }

  const queryPath = parsed.searchParams.get("path") ?? "";
  return extractProjectCodeFromDocsRelativePath(queryPath);
}

function projectAuthFilePath(projectCode: string, docsRoot: string, docsProjectAuthFileName: string): string {
  return join(docsRoot, "projects", projectCode, docsProjectAuthFileName);
}

function projectCookieName(projectCode: string): string {
  const normalized = projectCode.replace(/[^A-Za-z0-9]/g, "_");
  return `docs_auth_${normalized}`;
}

async function readProjectAuth(
  projectCode: string,
  docsRoot: string,
  docsProjectAuthFileName: string,
): Promise<{ password: string } | null> {
  const normalizedProjectCode = normalizeProjectCode(projectCode);
  if (!normalizedProjectCode) {
    return null;
  }

  const authPath = projectAuthFilePath(normalizedProjectCode, docsRoot, docsProjectAuthFileName);
  const stat = await statOrNull(authPath);
  if (!stat?.isFile()) {
    return null;
  }

  const raw = (await fs.readFile(authPath, "utf8")).trim();
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as { password?: unknown };
  if (typeof parsed.password !== "string" || parsed.password.length === 0) {
    return null;
  }

  return { password: parsed.password };
}

function isAllowedDocsToken(candidateToken: string, projectPassword: string | null, docsAuthToken: string): boolean {
  if (!candidateToken) {
    return false;
  }
  if (projectPassword && candidateToken === projectPassword) {
    return true;
  }
  if (docsAuthToken && candidateToken === docsAuthToken) {
    return true;
  }
  return false;
}

async function authorizeDocsRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  options: CreateAppOptions,
): Promise<void> {
  try {
    const projectCode = extractProjectCodeFromDocsRequest(req);
    if (!projectCode) {
      res.status(400).send("Project-scoped docs auth requires a project path under /docs/projects/<project-code>/...");
      return;
    }

    const auth = await readProjectAuth(projectCode, options.docsRoot, options.docsProjectAuthFileName);
    const projectPassword = auth?.password ?? null;
    if (!projectPassword && !options.docsAuthToken) {
      res.status(403).send("Project password is not initialized. Run /bind <project-code> first.");
      return;
    }

    const queryToken = typeof req.query.token === "string" ? req.query.token : "";
    if (isAllowedDocsToken(queryToken, projectPassword, options.docsAuthToken)) {
      res.setHeader("Set-Cookie", buildAuthCookie(projectCode, queryToken));
      const cleanedPath = stripTokenQuery(req.originalUrl);
      res.redirect(cleanedPath);
      return;
    }

    const cookieToken = parseCookie(req.headers.cookie ?? "", projectCookieName(projectCode));
    if (isAllowedDocsToken(cookieToken ?? "", projectPassword, options.docsAuthToken)) {
      next();
      return;
    }

    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}&project=${encodeURIComponent(projectCode)}`);
  } catch (error) {
    next(error);
  }
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

try {
  process.loadEnvFile(`${root}.env.local`);
} catch {
  // no local env file; /api/config will report cloud sync as off
}

const { GET: getConfig } = await import("./api/config.js");
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "127.0.0.1";
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

// Only the app's own files are served. Everything else in the project
// folder (.env.local, .git, scripts, migrations) stays private.
const PUBLIC_FILES = new Set(["/index.html", "/styles.css"]);
const PUBLIC_DIRS = ["/js/"];
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
  `${host}:${port}`
]);

function isPublicPath(pathname) {
  if (pathname.split("/").some((segment) => segment.startsWith("."))) {
    return false;
  }
  return PUBLIC_FILES.has(pathname) || PUBLIC_DIRS.some((dir) => pathname.startsWith(dir));
}

const server = createServer(async (request, response) => {
  try {
    // Reject other Host headers so a web page cannot reach this server
    // through DNS rebinding.
    if (!ALLOWED_HOSTS.has(String(request.headers.host || "").toLowerCase())) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === "/api/config") {
      const result = getConfig();
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
      return;
    }

    const pathname =
      url.pathname === "/"
        ? "/index.html"
        : decodeURIComponent(url.pathname);
    const filePath = resolve(root, `.${pathname}`);

    if (
      !isPublicPath(pathname) ||
      !filePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
    ) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const fileStat = await stat(filePath);

    if (!fileStat.isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": types[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch (error) {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Foosball DYP running at http://${host}:${port}`);
});

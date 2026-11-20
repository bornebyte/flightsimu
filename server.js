import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDispatcherRecommendation } from "./lib/dispatcher.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const MAX_BODY_BYTES = 64 * 1024;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}


const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/network") {
    try {
      const data = await readFile(resolve(ROOT, "flight_network.json"));
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      response.end(data);
    } catch {
      sendJson(response, 500, { error: "The flight network dataset could not be loaded." });
    }
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/dispatcher") {
    try {
      const payload = await readJsonBody(request);
      sendJson(response, 200, await getDispatcherRecommendation(payload));
    } catch (error) {
      sendJson(response, error.statusCode || 502, { error: error.message || "Dispatcher service failed." });
    }
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(ROOT, `.${requestedPath}`);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) {
    sendJson(response, 403, { error: "Forbidden." });
    return;
  }
  try {
    const data = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    });
    response.end(request.method === "HEAD" ? undefined : data);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Domino Sky is listening on http://localhost:${PORT}`);
});

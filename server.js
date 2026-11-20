import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

async function callDispatcher(payload) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("Groq is not configured. Set GROQ_API_KEY to enable AI; using the deterministic demo dispatcher."), { statusCode: 503 });
  }
  if (!payload || typeof payload !== "object" || !payload.incident || !payload.network_metrics || !Array.isArray(payload.candidate_recovery_actions)) {
    throw Object.assign(new Error("Dispatcher input is missing simulation state."), { statusCode: 400 });
  }
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const baseUrl = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const systemPrompt = [
    "You are an airline operations dispatcher. You receive the authoritative output of a deterministic flight network simulation.",
    "Never invent or modify numerical values. Never perform passenger, delay, crew, or flight calculations. Use only supplied state.",
    "Explain what is happening, the main bottlenecks, and the tradeoffs of a recovery option.",
    "Recommend only an action_id that exactly matches one supplied candidate. If there is no useful action, return action_id as null.",
    "Candidate metrics are deterministic engine results. Do not copy or calculate new metrics.",
    "Return JSON only with keys: assessment (string), bottlenecks (array of strings), action_id (string or null), reason (string), tradeoffs (array of strings)."
  ].join(" ");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) }
      ]
    })
  });
  if (!response.ok) throw Object.assign(new Error(`AI provider returned HTTP ${response.status}.`), { statusCode: 502 });
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw Object.assign(new Error("AI provider returned an empty response."), { statusCode: 502 });
  let recommendation;
  try {
    recommendation = JSON.parse(content);
  } catch {
    throw Object.assign(new Error("AI provider returned invalid structured output."), { statusCode: 502 });
  }
  const allowedIds = new Set(payload.candidate_recovery_actions.map((candidate) => candidate.id));
  if (recommendation.action_id !== null && !allowedIds.has(recommendation.action_id)) {
    recommendation.action_id = null;
    recommendation.reason = "The proposed action did not match a validated candidate, so no action was selected.";
  }
  return {
    mode: "AI",
    assessment: String(recommendation.assessment || "The network state was analyzed."),
    bottlenecks: Array.isArray(recommendation.bottlenecks) ? recommendation.bottlenecks.map(String).slice(0, 5) : [],
    actionId: recommendation.action_id,
    reason: String(recommendation.reason || "No additional reasoning was returned."),
    tradeoffs: Array.isArray(recommendation.tradeoffs) ? recommendation.tradeoffs.map(String).slice(0, 5) : []
  };
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
      sendJson(response, 200, await callDispatcher(payload));
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

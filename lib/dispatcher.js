export async function getDispatcherRecommendation(payload, env = process.env) {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("Groq is not configured. Set GROQ_API_KEY to enable AI; using the deterministic demo dispatcher."), { statusCode: 503 });
  }
  if (!payload || typeof payload !== "object" || !payload.incident || !payload.network_metrics || !Array.isArray(payload.candidate_recovery_actions)) {
    throw Object.assign(new Error("Dispatcher input is missing simulation state."), { statusCode: 400 });
  }
  const model = env.GROQ_MODEL || "openai/gpt-oss-120b";
  const baseUrl = (env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const systemPrompt = [
    "You are an airline operations dispatcher. You receive the authoritative output of a deterministic flight network simulation.",
    "Never invent or modify numerical values. Never perform passenger, delay, crew, or flight calculations. Use only supplied state.",
    "Explain what is happening, the main bottlenecks, and the tradeoffs of a recovery option.",
    "Recommend only an action_id that exactly matches one supplied candidate. If there is no useful action, return action_id as null.",
    "Candidate metrics are deterministic engine results. Do not copy or calculate new metrics.",
    "Return JSON only with keys: assessment (string), bottlenecks (array of strings), action_id (string or null), reason (string), tradeoffs (array of strings)."
  ].join(" ");
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
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
  } catch {
    throw Object.assign(new Error("Could not reach Groq. Check the API key and try again."), { statusCode: 502 });
  }
  if (!response.ok) throw Object.assign(new Error(`Groq returned HTTP ${response.status}. Check GROQ_API_KEY and GROQ_MODEL.`), { statusCode: 502 });
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw Object.assign(new Error("Groq returned an empty response."), { statusCode: 502 });
  let recommendation;
  try {
    recommendation = JSON.parse(content);
  } catch {
    throw Object.assign(new Error("Groq returned invalid structured output."), { statusCode: 502 });
  }
  const allowedIds = new Set(payload.candidate_recovery_actions.map((candidate) => candidate.id));
  if (recommendation.action_id !== null && !allowedIds.has(recommendation.action_id)) {
    recommendation.action_id = null;
    recommendation.reason = "The proposed action did not match a validated candidate, so no action was selected.";
  }
  return {
    mode: "AI · GROQ",
    assessment: String(recommendation.assessment || "The network state was analyzed."),
    bottlenecks: Array.isArray(recommendation.bottlenecks) ? recommendation.bottlenecks.map(String).slice(0, 5) : [],
    actionId: recommendation.action_id,
    reason: String(recommendation.reason || "No additional reasoning was returned."),
    tradeoffs: Array.isArray(recommendation.tradeoffs) ? recommendation.tradeoffs.map(String).slice(0, 5) : []
  };
}

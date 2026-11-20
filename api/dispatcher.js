import { getDispatcherRecommendation } from "../lib/dispatcher.js";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request) {
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    return Response.json(await getDispatcherRecommendation(payload));
  } catch (error) {
    return Response.json(
      { error: error.message || "Dispatcher service failed." },
      { status: error.statusCode || 502 }
    );
  }
}

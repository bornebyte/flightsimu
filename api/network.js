import { readFile } from "node:fs/promises";

export async function GET() {
  try {
    const data = await readFile(new URL("../flight_network.json", import.meta.url));
    return new Response(data, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60",
        "x-content-type-options": "nosniff"
      }
    });
  } catch {
    return Response.json({ error: "The flight network dataset could not be loaded." }, { status: 500 });
  }
}

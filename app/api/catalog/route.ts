import { SKUS } from "@/lib/catalog";

// The catalogue is static for the life of the deployment (fictional brand "Fernweave").
export async function GET(): Promise<Response> {
  return Response.json({ skus: SKUS }, { headers: { "Cache-Control": "public, max-age=300" } });
}

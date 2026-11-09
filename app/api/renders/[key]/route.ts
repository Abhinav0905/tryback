import { errorResponse, isSafeId } from "@/lib/apiRoute";
import { readDb, readRender, renderBlobName } from "@/lib/store";

export const runtime = "nodejs";

const VERSION_RE = /^(clothsy|dev)-[a-z0-9]{1,16}$/;

// GET /api/renders/[key][?v=<version>] → image bytes. Renders are content-addressed (cache
// key = hash of photo + garment + pipeline version) and a URL's bytes never change: a
// re-render of a key (e.g. a dev → live upgrade) is stored as a new version with its own
// `?v=`, so the URL can be cached as immutable without ever showing the wrong preview.
export async function GET(req: Request, ctx: RouteContext<"/api/renders/[key]">): Promise<Response> {
  try {
    const { key } = await ctx.params;
    if (!isSafeId(key)) return errorResponse(400, "INVALID_ID", "That preview id isn't valid.");
    const v = new URL(req.url).searchParams.get("v");
    if (v !== null && !VERSION_RE.test(v)) return errorResponse(400, "INVALID_ID", "That preview version isn't valid.");
    const bytes = await readRender(renderBlobName(key, v));
    if (!bytes) return errorResponse(404, "RENDER_NOT_FOUND", "We couldn't find that preview.");
    const indexed = (await readDb()).renderIndex[key];
    const entry = indexed && (indexed.version ?? null) === v ? indexed : null;
    const contentType = entry && /^image\/[a-z0-9.+-]+$/i.test(entry.contentType) ? entry.contentType : sniffImageType(bytes);
    const provider = entry?.provider ?? (v ? v.slice(0, v.indexOf("-")) : "unknown");
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "X-TryBack-Provider": provider,
      },
    });
  } catch (err) {
    console.error("[api/renders] failed", err);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong on our side. Please try again.");
  }
}

function sniffImageType(b: Buffer): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "image/jpeg";
}

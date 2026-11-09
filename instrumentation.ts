// Runs once when a Next.js server instance starts (next dev, next start, standalone server.js).
// On the Node.js runtime it starts the hourly retention sweeper and logs unsafe configuration
// (lib/boot.ts). Skipped during `next build`. The conditional import keeps Node-only code out
// of the Edge compile.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { bootNodeServer } = await import("./lib/boot");
    await bootNodeServer();
  }
}

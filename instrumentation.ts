export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureRuntime } = await import("@/lib/runtime-supervisor");
    await ensureRuntime();
  } catch (err) {
    console.error("[instrumentation] runtime supervisor failed:", err);
  }
}

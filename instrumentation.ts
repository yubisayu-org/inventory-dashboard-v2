export async function register() {
  // Closing the pools on the way out lives in lib/shutdown.ts, imported here
  // rather than at module scope: the Edge bundle is compiled from this file
  // too, and it will not compile a `process.once` it can never run.
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./lib/shutdown")
}

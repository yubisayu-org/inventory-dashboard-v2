/**
 * Drop-in replacement for `fetch().then(r => r.json())` with:
 *   - AbortController-backed timeout (default 30s)
 *   - Automatic { error: "..." } extraction from non-2xx or 200-with-body-error responses
 *   - cache: "no-store" by default (matches existing convention across the app)
 *
 * Guarantees the returned promise resolves or rejects within `timeoutMs` —
 * loading spinners can no longer hang indefinitely on a stuck network.
 */
export async function fetchJson<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = 30000, ...rest } = init ?? {}
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(input, { cache: "no-store", ...rest, signal: ctrl.signal })
    let body: unknown = null
    try { body = await res.json() } catch { /* empty / non-JSON response */ }

    const errorMsg =
      body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : null

    if (!res.ok || errorMsg) {
      throw new Error(errorMsg ?? `HTTP ${res.status}`)
    }
    return body as T
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Request timed out — the server didn't respond in time")
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { publicOrigin } from "./public-origin"

// The origin a browser used, which behind a proxy is not the one this process
// was addressed on. Getting it wrong hands Google a redirect_uri pointing at
// localhost, and no sign-in can ever complete.

function req(headers: Record<string, string>, origin = "https://localhost:8080") {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { origin },
  } as never
}

test("the forwarded host wins over the address this process answers on", () => {
  assert.equal(
    publicOrigin(req({ "x-forwarded-host": "yubisayu.up.railway.app", "x-forwarded-proto": "https" })),
    "https://yubisayu.up.railway.app",
  )
})

test("a chain of proxies names the browser's own hop first", () => {
  assert.equal(
    publicOrigin(req({
      "x-forwarded-host": "shop.example.com, internal.railway",
      "x-forwarded-proto": "https, http",
    })),
    "https://shop.example.com",
  )
})

test("https is assumed when the proxy forwards a host but no scheme", () => {
  assert.equal(publicOrigin(req({ "x-forwarded-host": "shop.example.com" })), "https://shop.example.com")
})

// Locally there is no proxy, and the request origin is the right answer.
test("with no forwarded headers the request's own origin stands", () => {
  assert.equal(publicOrigin(req({}, "http://localhost:3001")), "http://localhost:3001")
})

test("PUBLIC_ORIGIN overrides everything, for a proxy that does not say", () => {
  process.env.PUBLIC_ORIGIN = "https://pinned.example.com/"
  try {
    assert.equal(
      publicOrigin(req({ "x-forwarded-host": "ignored.example.com" })),
      "https://pinned.example.com",
      "and the trailing slash is dropped, or every URL built from it doubles up",
    )
  } finally {
    delete process.env.PUBLIC_ORIGIN
  }
})

test("a PUBLIC_ORIGIN without a scheme is not an origin, and is ignored", () => {
  process.env.PUBLIC_ORIGIN = "yubisayu.up.railway.app"
  try {
    assert.equal(publicOrigin(req({}, "http://localhost:3001")), "http://localhost:3001")
  } finally {
    delete process.env.PUBLIC_ORIGIN
  }
})

import { test } from "node:test"
import assert from "node:assert/strict"

// Set before any signing happens. secret() reads the env at call time, not at
// import time, so a plain import is fine.
process.env.AUTH_SECRET ??= "test-secret-for-state-signing"

import { signState, verifyState } from "./catalogue-oauth-state"

test("a signed state round-trips its invite", () => {
  assert.deepEqual(verifyState(signState("invite-abc")), {
    invite: "invite-abc",
    siteNonce: "",
  })
})

test("an empty invite round-trips — that is a returning customer", () => {
  assert.deepEqual(verifyState(signState("")), { invite: "", siteNonce: "" })
})

test("the catalogue's login nonce round-trips", () => {
  assert.deepEqual(verifyState(signState("inv", "browser-nonce")), {
    invite: "inv",
    siteNonce: "browser-nonce",
  })
})

test("swapping the nonce invalidates the state", () => {
  // Without signing it, a browser could substitute its own nonce mid-flow and
  // redeem a code minted elsewhere.
  const state = signState("inv", "victim-nonce")
  const [rand, invite, , mac] = state.split(".")
  assert.equal(verifyState(`${rand}.${invite}.attacker-nonce.${mac}`), null)
})

test("swapping the invite for another invalidates the state", () => {
  // The attack this exists to stop: edit the URL mid-flow to bind your own
  // Google account to somebody else's invite.
  const state = signState("invite-mine")
  const [nonce, , mac] = state.split(".")
  assert.equal(verifyState(`${nonce}.invite-theirs.${mac}`), null)
})

test("a tampered mac is rejected", () => {
  const [nonce, invite] = signState("invite-abc").split(".")
  assert.equal(verifyState(`${nonce}.${invite}.notavalidmac`), null)
})

test("malformed state is rejected rather than throwing", () => {
  assert.equal(verifyState(""), null)
  assert.equal(verifyState("one.two"), null)
  assert.equal(verifyState("a.b.c.d"), null)
})

test("two sign-ins with the same invite produce different state", () => {
  assert.notEqual(signState("invite-abc"), signState("invite-abc"))
})

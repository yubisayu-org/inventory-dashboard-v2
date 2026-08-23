import { test } from "node:test"
import assert from "node:assert/strict"
import { routeOf, routeKeyOf, type DispatchRoute } from "./dispatch-modes"

const route = (key: string, label: string, prefixes: string[]): DispatchRoute =>
  ({ key, label, prefixes, warnDays: 7, lateDays: 14 })

const ROUTES = [
  route("hc", "Hand Carry", ["HC"]),
  route("air", "Air Cargo", ["CJI"]),
  // One route, two codes: the sea forwarder books under both.
  route("sea", "Sea Cargo", ["MNC", "MU"]),
]

test("either of a route's codes finds the same route", () => {
  assert.equal(routeKeyOf("MNC-29786", ROUTES), "sea")
  assert.equal(routeKeyOf("MU-19953", ROUTES), "sea")
})

test("the longer code wins, whichever route it belongs to", () => {
  // MU is sea; MUX is a hypothetical air code that starts with it. The more
  // specific match must win regardless of the order routes are listed in.
  const routes = [...ROUTES, route("mux", "Air Express", ["MUX"])]
  assert.equal(routeKeyOf("MUX-1", routes), "mux")
  assert.equal(routeKeyOf("MU-1", routes), "sea")
})

test("a code nobody claims is other, not a guess", () => {
  assert.equal(routeKeyOf("POCN202607", ROUTES), "other")
  assert.equal(routeOf("POCN202607", ROUTES), null)
})

test("casing and stray spaces are noise", () => {
  assert.equal(routeKeyOf("  mu-19953 ", ROUTES), "sea")
})

test("an empty receipt belongs to no route", () => {
  assert.equal(routeOf("", ROUTES), null)
  assert.equal(routeKeyOf("", ROUTES), "other")
})

test("a route carrying no codes matches nothing rather than everything", () => {
  assert.equal(routeKeyOf("ANY-1", [route("empty", "Empty", [])]), "other")
})

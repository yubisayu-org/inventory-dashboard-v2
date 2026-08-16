import { test } from "node:test"
import assert from "node:assert/strict"
import { clusterPoints, DEFAULT_CLUSTER_RADIUS } from "./cluster"

test("marks on the same item become one slot", () => {
  const clusters = clusterPoints([
    { x: 0.24, y: 0.78 },
    { x: 0.25, y: 0.79 },
    { x: 0.243, y: 0.775 },
  ])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].members.length, 3)
  assert.ok(Math.abs(clusters[0].centre.x - 0.244) < 0.01)
})

test("marks on different items stay apart", () => {
  const clusters = clusterPoints([
    { x: 0.24, y: 0.78 },
    { x: 0.41, y: 0.77 },
  ])
  assert.equal(clusters.length, 2)
})

test("busiest slot comes first", () => {
  const clusters = clusterPoints([
    { x: 0.8, y: 0.2 },
    { x: 0.24, y: 0.78 },
    { x: 0.25, y: 0.78 },
    { x: 0.245, y: 0.785 },
  ])
  assert.equal(clusters[0].members.length, 3)
  assert.equal(clusters[1].members.length, 1)
})

test("members point back at the claims that formed the slot", () => {
  const clusters = clusterPoints([
    { x: 0.8, y: 0.2 },
    { x: 0.24, y: 0.78 },
    { x: 0.25, y: 0.78 },
  ])
  const busiest = clusters[0]
  assert.deepEqual([...busiest.members].sort(), [1, 2])
})

test("a chain of marks does not merge distant items", () => {
  // Points a hair under the radius apart, stepping across the frame. Naive
  // transitive grouping would swallow the whole row into one slot.
  const points = Array.from({ length: 8 }, (_, i) => ({ x: 0.1 + i * 0.05, y: 0.5 }))
  const clusters = clusterPoints(points)
  assert.ok(clusters.length > 1, `expected several slots, got ${clusters.length}`)
})

test("no points, no slots", () => {
  assert.deepEqual(clusterPoints([]), [])
})

test("the default radius is exported for callers that tune it", () => {
  assert.equal(DEFAULT_CLUSTER_RADIUS, 0.06)
})

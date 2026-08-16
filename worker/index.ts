import { startSession } from "./session"

async function main() {
  await startSession((sock) => {
    // Handlers are attached in later tasks. Connecting is the whole of task 1,
    // and it is worth confirming on its own before anything reads a message.
    void sock
  })
}

main().catch((err) => {
  console.error("worker failed to start:", err)
  process.exit(1)
})

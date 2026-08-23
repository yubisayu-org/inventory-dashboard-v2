# WhatsApp Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the bot in the group: capture the owner's shelf photos as posts, turn customers' replies into claims, acknowledge every claim with a reaction, read the owner's ✅ as a purchase, and post the shopping list on `/rekap`.

**Architecture:** A long-running Node process outside Next.js, since a serverless handler cannot hold a socket. It imports the same `lib/db/*` and `lib/whatsapp/*` modules the dashboard uses, so there is one implementation of ingestion, clustering and rendering and the worker is only a transport. WhatsApp is reached through Baileys, which links as a companion device to the bot number's phone.

**Tech Stack:** `baileys` 6.7.24, `qrcode-terminal`, TypeScript run by `tsx`, `postgres` (postgres.js), `node:test`.

**Spec:** [docs/superpowers/specs/2026-08-16-whatsapp-claim-capture-design.md](../specs/2026-08-16-whatsapp-claim-capture-design.md)

**Depends on:** [2026-08-16-claim-resolvers.md](2026-08-16-claim-resolvers.md), [2026-08-16-claim-capture-backend.md](2026-08-16-claim-capture-backend.md), [2026-08-17-claim-capture-slots-and-rekap.md](2026-08-17-claim-capture-slots-and-rekap.md), [2026-08-17-claim-capture-dashboard.md](2026-08-17-claim-capture-dashboard.md) — all complete.

## Decisions already made

Settled with the owner across 2026-08-16 and 2026-08-17. Do not relitigate.

- **Posts originate in WhatsApp.** The owner photographs a shelf and sends it to
  the group; the dashboard upload is a fallback.
- **`/mulai <store>` … `/selesai`** frame a capture window. Images the owner
  sends inside it become posts; outside it they are ordinary chat. The window
  carries the store, so nothing is typed per photo.
- **`/rekap` is admin-only**, checked against `wa_admins`, and **silently
  ignored** from anyone else — an error reply would invite retries.
- **Binding a group to an event is the connector's alone**, because it decides
  where a whole trip's claims land.
- **The owner's ✅ on a claim means that claim was bought**; ❌ means it was not.
  Only from numbers on the admin list.
- **The bot is reply-only.** It never opens a conversation, never asks for a
  substitution, and never posts the shopping list unprompted.
- **Reaction vocabulary**, from the spec — do not invent others:

  | When | Emoji | Meaning |
  |---|---|---|
  | Captured | 📝 | Understood and recorded |
  | Captured | ❔ | Partly understood — needs a size or colour |
  | Captured | 😢 | Could not be read; please retype |
  | After buying | ✅ | Secured for this customer |
  | After buying | ❌ | Not obtained |

## Global Constraints

- Node `22.x` per `package.json` `engines`; Baileys requires `>=20`.
- Migrations start at **066**, applied by piping to psql — `supabase migration up`
  does not work on this branch:
  ```bash
  PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
  "$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f <file>
  ```
- **Pin `baileys@6.7.24`.** The `latest` tag is `7.0.0-rc14`, a release
  candidate; `6.7.24` carries the `legacy` tag and is the stable line. Every API
  used below was checked against 6.7.24's own type definitions.
- Imports are extensionless. The worker uses the `@/lib/...` alias, which `tsx`
  resolves from `tsconfig.json` — the existing `lib/whatsapp/ingest.ts` already
  relies on this and its tests pass.
- Tests run with `npm test`, which globs `lib/**` — add `worker/*.test.ts` to
  that glob in Task 2.
- Never log a message body or a customer's number at info level. This process
  sees a whole group's chat.
- Comments explain *why*, at the density of `lib/db/fulfillment.ts`.

## Before starting: what the owner must have

- The dedicated bot SIM, in a phone with WhatsApp registered on it. **Obtained.**
- A spare Android kept online and its prepaid credit current. Companion devices
  log out after roughly 14 days with the primary phone offline. **Obtained.**
- A machine to run the worker on that stays awake — a laptop that does not sleep,
  a Raspberry Pi, or a small VPS. The process holds a socket, so it cannot live
  on Netlify or Vercel beside the dashboard. This is the one operational choice
  the plan does not make.

---

### Task 1: Migration 066, and a socket that stays connected

**Files:**
- Create: `supabase/migrations/066_wa_post_message.sql`
- Modify: `lib/db/claims.ts`
- Modify: `package.json` (dependencies and a `worker` script)
- Modify: `.gitignore`
- Create: `worker/env.ts`
- Create: `worker/logger.ts`
- Create: `worker/session.ts`
- Create: `worker/index.ts`

**Interfaces:**
- Produces:
  - `wa_posts.message_id` and `wa_posts.group_jid`, so a reply can find the post it quotes.
  - `createPost` accepts `messageId` and `groupJid`; `findPostByMessage(groupJid, messageId)`.
  - `startSession(): Promise<WASocket>` — connects, prints a QR when unlinked, reconnects when dropped.

A customer's reply carries the quoted message's id, and that is the only thing
tying it to a post. Without this column every reply would have to be matched by
re-downloading and comparing images.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/066_wa_post_message.sql`:

```sql
-- How a reply finds the post it is replying to.
--
-- A quoted message carries only the original's id, so without this the worker
-- would have to re-download each reply's quoted image and match it against
-- every post — expensive, and wrong as soon as two shelves look alike.
--
-- Both columns are nullable and default empty: posts created from the dashboard
-- were never sent to a group and have neither.
ALTER TABLE wa_posts ADD COLUMN IF NOT EXISTS message_id TEXT NOT NULL DEFAULT '';
ALTER TABLE wa_posts ADD COLUMN IF NOT EXISTS group_jid TEXT NOT NULL DEFAULT '';

-- The lookup the worker does on every single reply.
CREATE INDEX IF NOT EXISTS idx_wa_posts_message
  ON wa_posts (group_jid, message_id) WHERE message_id <> '';
```

Apply it, then confirm:

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/066_wa_post_message.sql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d wa_posts" | grep -E 'message_id|group_jid'
```

Expected: both columns listed.

- [ ] **Step 2: Carry them through the data layer**

In `lib/db/claims.ts`, add to the `WaPost` interface after `note`:

```typescript
  /** The WhatsApp message this post was sent as. Empty for dashboard uploads. */
  messageId: string
  groupJid: string
```

to `mapPost`, after the `note` line:

```typescript
    messageId: (r.message_id as string) ?? "",
    groupJid: (r.group_jid as string) ?? "",
```

to `createPost`'s input type:

```typescript
  safeHues: number[]
  messageId?: string
  groupJid?: string
```

and to its INSERT:

```typescript
    INSERT INTO wa_posts (event, image_path, image_width, image_height, store,
      country_id, pricing_method, note, safe_hues, message_id, group_jid)
    VALUES (${input.event}, ${input.imagePath}, ${input.imageWidth},
      ${input.imageHeight}, ${input.store}, ${input.countryId},
      ${input.pricingMethod}, ${input.note}, ${input.safeHues},
      ${input.messageId ?? ""}, ${input.groupJid ?? ""})
    RETURNING id
```

Then add the lookup beside `getPost`:

```typescript
/**
 * The post a reply is quoting.
 *
 * Scoped to the group as well as the message id: ids are unique per chat, not
 * globally, and two groups running two trips must not resolve to each other's
 * shelves.
 */
export async function findPostByMessage(
  groupJid: string,
  messageId: string,
): Promise<WaPost | null> {
  if (!messageId) return null
  const [row] = await sql`
    SELECT * FROM wa_posts
    WHERE group_jid = ${groupJid} AND message_id = ${messageId}
  `
  return row ? mapPost(row) : null
}
```

- [ ] **Step 3: Install the dependencies and add the script**

```bash
npm install baileys@6.7.24 qrcode-terminal
npm install --save-dev @types/qrcode-terminal
```

In `package.json`, add to `scripts`:

```json
"worker": "tsx --env-file-if-exists=.env.local --env-file-if-exists=.env.development.local worker/index.ts"
```

In `.gitignore`, add:

```
# Baileys device credentials — a linked WhatsApp session. Never commit.
.wa-session/
```

- [ ] **Step 4: The env and logger**

Create `worker/env.ts`:

```typescript
/**
 * Where the linked-device credentials live.
 *
 * A folder rather than a row in Postgres: Baileys writes it constantly during a
 * session, and it is the one piece of state that must NOT be shared between two
 * running workers — two processes on one session get logged out.
 */
export const SESSION_DIR = process.env.WA_SESSION_DIR ?? ".wa-session"

/** How the device is named in WhatsApp's linked-devices list. */
export const DEVICE_NAME = process.env.WA_DEVICE_NAME ?? "Yubisayu Dashboard"
```

Create `worker/logger.ts`:

```typescript
import type { ILogger } from "baileys/lib/Utils/logger"

/**
 * A quiet logger for Baileys.
 *
 * Baileys defaults to a pino instance at trace level, which prints every frame
 * on the wire — including message bodies and every member's number. This
 * process sees a whole group's chat, so the default is not merely noisy, it is
 * a privacy problem in a log file.
 *
 * Warnings and errors still come through, because a session that is failing to
 * reconnect must be visible.
 */
export const quietLogger: ILogger = {
  level: "warn",
  child: () => quietLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (obj, msg) => console.warn(msg ?? "", obj ?? ""),
  error: (obj, msg) => console.error(msg ?? "", obj ?? ""),
}
```

- [ ] **Step 5: The session**

Create `worker/session.ts`:

```typescript
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "baileys"
import type { WASocket } from "baileys"
import qrcode from "qrcode-terminal"
import { DEVICE_NAME, SESSION_DIR } from "./env"
import { quietLogger } from "./logger"

/**
 * Connect, and keep connecting.
 *
 * WhatsApp drops companion sockets routinely — a phone changing network, a
 * server restart on their side — and every one of those is recoverable by
 * reconnecting with the same credentials. The one that is not is a logout,
 * where the credentials are gone and a human has to scan a code again. Retrying
 * that in a loop would hammer WhatsApp with a dead session, which is exactly the
 * behaviour that gets a number banned.
 *
 * `onReady` runs on every successful connection, not just the first, so
 * handlers must be idempotent — they are re-attached to a fresh socket each
 * time.
 */
export async function startSession(
  onReady: (sock: WASocket) => void,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: quietLogger,
    // The bot should not appear "online" all day. Presence is an activity
    // signature, and this account only ever reacts and answers commands.
    markOnlineOnConnect: false,
    // Nothing here reads history: claims arrive live, and a full sync on every
    // reconnect is a large download for data already in Postgres.
    syncFullHistory: false,
    browser: [DEVICE_NAME, "Chrome", "1.0.0"],
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log("\nScan this from the bot phone: WhatsApp → Linked devices\n")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      console.log("connected as", sock.user?.id ?? "unknown")
      onReady(sock)
    }

    if (connection === "close") {
      // Baileys wraps the close reason in a Boom error. Read the status
      // structurally rather than importing @hapi/boom, which is only a
      // transitive dependency and would have to become a direct one for a type.
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode
      if (status === DisconnectReason.loggedOut) {
        console.error(
          `logged out. Delete ${SESSION_DIR} and run the worker again to link a fresh device.`,
        )
        process.exit(1)
      }
      console.warn("connection closed, reconnecting…", status ?? "")
      void startSession(onReady)
    }
  })
}
```

- [ ] **Step 6: The entry point**

Create `worker/index.ts`:

```typescript
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
```

- [ ] **Step 7: Link the device**

```bash
npx tsc --noEmit
npm run worker
```

Expected: a QR block in the terminal. On the bot phone, WhatsApp → Linked
devices → Link a device, and scan it. The terminal then prints
`connected as 62…@s.whatsapp.net`.

Stop with Ctrl-C, run `npm run worker` again, and confirm it reconnects **with
no QR** — that proves the credentials persisted, which is the whole point of
this task.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/066_wa_post_message.sql lib/db/claims.ts worker package.json package-lock.json .gitignore
git commit -m "feat(worker): a WhatsApp session that stays connected

A reply carries only the quoted message's id, so wa_posts learns the message and
group it was sent as. Without that the worker would have to re-download every
reply's quoted image and compare it against every post — expensive, and wrong
the moment two shelves look alike.

Baileys is pinned to 6.7.24 rather than the latest tag, which is a release
candidate. Drops are reconnected automatically because WhatsApp closes companion
sockets routinely; a logout is not, because retrying a dead session in a loop is
what gets a number banned.

The logger is deliberately quiet. Baileys defaults to printing every frame,
which for this process means a whole group's messages and every member's number
in a log file."
```

---

### Task 2: The command grammar

**Files:**
- Create: `worker/commands.ts`
- Create: `worker/commands.test.ts`
- Modify: `package.json` (widen the test glob)

**Interfaces:**
- Produces: `parseCommand(text: string): Command | null` where
  ```typescript
  type Command =
    | { kind: "connect" }
    | { kind: "open"; store: string }
    | { kind: "close" }
    | { kind: "rekap" }
  ```

Kept pure and separate from the socket so the grammar can be tested without
WhatsApp, and so adding an alias never risks the message loop.

- [ ] **Step 1: Widen the test glob**

In `package.json`:

```json
"test": "tsx --env-file-if-exists=.env.development.local --test lib/claims/*.test.ts lib/*.test.ts lib/db/*.test.ts lib/whatsapp/*.test.ts worker/*.test.ts"
```

- [ ] **Step 2: Write the failing test**

Create `worker/commands.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseCommand } from "./commands"

test("opening a capture window carries the store", () => {
  assert.deepEqual(parseCommand("/mulai Nishimatsuya"), {
    kind: "open",
    store: "Nishimatsuya",
  })
  assert.deepEqual(parseCommand("/mulai Akachan Honpo Umeda"), {
    kind: "open",
    store: "Akachan Honpo Umeda",
  })
})

test("a window can be opened without naming a store", () => {
  // The owner can add it in the dashboard later; refusing here would mean
  // standing in a shop arguing with a bot.
  assert.deepEqual(parseCommand("/mulai"), { kind: "open", store: "" })
})

test("the other commands take no argument", () => {
  assert.deepEqual(parseCommand("/selesai"), { kind: "close" })
  assert.deepEqual(parseCommand("/rekap"), { kind: "rekap" })
  assert.deepEqual(parseCommand("/connect"), { kind: "connect" })
})

test("case and stray whitespace do not stop a command working", () => {
  assert.deepEqual(parseCommand("  /REKAP  "), { kind: "rekap" })
  assert.deepEqual(parseCommand("/Mulai   Loft  "), { kind: "open", store: "Loft" })
})

test("ordinary chat is not a command", () => {
  assert.equal(parseCommand("mau yg 95 ya kak"), null)
  assert.equal(parseCommand(""), null)
  assert.equal(parseCommand("rekap dong kak"), null, "a command must start with a slash")
})

test("an unknown slash word is not a command", () => {
  // Silence, not an error: the group is full of humans, and a bot correcting
  // their typing is noise nobody asked for.
  assert.equal(parseCommand("/tutup"), null)
  assert.equal(parseCommand("/help"), null)
})

test("a command must be the whole first word, not part of one", () => {
  assert.equal(parseCommand("/rekapitulasi"), null)
})
```

- [ ] **Step 3: Run to confirm it fails**

Run: `npx tsx --test worker/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 4: Implement**

Create `worker/commands.ts`:

```typescript
export type Command =
  | { kind: "connect" }
  | { kind: "open"; store: string }
  | { kind: "close" }
  | { kind: "rekap" }

/**
 * Read a command out of a message, or decide it was not one.
 *
 * Indonesian words, because that is what gets typed standing in a shop. The
 * grammar is deliberately tiny: a leading slash, one word, and for /mulai
 * everything after it as the store name — no flags, no quoting, nothing to get
 * wrong one-handed.
 *
 * Anything unrecognised returns null and the caller stays silent. The group is
 * full of humans, and a bot correcting their typing is noise nobody asked for.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  const spaceAt = trimmed.search(/\s/)
  const word = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toLowerCase()
  const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt).trim().replace(/\s+/g, " ")

  switch (word) {
    case "/connect":
      return { kind: "connect" }
    case "/mulai":
      // No store is allowed on purpose: it can be filled in from the dashboard,
      // and refusing would mean standing in a shop arguing with a bot.
      return { kind: "open", store: rest }
    case "/selesai":
      return { kind: "close" }
    case "/rekap":
      return { kind: "rekap" }
    default:
      return null
  }
}
```

- [ ] **Step 5: Run the tests and commit**

Run: `npm test`
Expected: PASS — everything, plus seven command tests.

```bash
git add worker/commands.ts worker/commands.test.ts package.json
git commit -m "feat(worker): the command grammar

Indonesian words, because that is what gets typed standing in a shop. A leading
slash, one word, and for /mulai everything after it as the store — no flags, no
quoting, nothing to get wrong one-handed.

/mulai with no store is allowed rather than rejected: the store can be filled in
from the dashboard, and refusing would mean standing in a shop arguing with a
bot. Anything unrecognised parses to nothing and the caller stays silent, since
a bot correcting people's typing is noise nobody asked for."
```

---

### Task 3: Who may command the bot, and what the commands do

**Files:**
- Create: `worker/handle-command.ts`
- Create: `worker/handle-command.test.ts`

**Interfaces:**
- Consumes: `parseCommand`; `isBotAdmin`, `canConnect`, `upsertGroup`, `bindGroupToEvent`, `openCapture`, `closeCapture` from `lib/db/whatsapp-groups`.
- Produces:
  - `senderNumber(jid: string): string`
  - `runCommand(input: { command, groupJid, groupName, sender }): Promise<CommandResult>` where `CommandResult` is `{ reply?: string; react?: string; rekap?: true }`.

`runCommand` returns what should happen rather than doing it, so the whole
permission model is testable without a socket.

- [ ] **Step 1: Write the failing test**

Create `worker/handle-command.test.ts`:

```typescript
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import sql from "../lib/db-pool"
import { addBotAdmin, currentCapture, listGroups } from "../lib/db/whatsapp-groups"
import { senderNumber, runCommand } from "./handle-command"

const EVENT = `TESTCMD${process.hrtime.bigint()}`
const JID = `${process.hrtime.bigint()}@g.us`
const OWNER = "628110000001"
const HELPER = "628110000002"
const STRANGER = "628119999999"

before(async () => {
  await sql`
    INSERT INTO events (name, warehouse_id)
    SELECT ${EVENT}, id FROM warehouses ORDER BY id LIMIT 1
    ON CONFLICT DO NOTHING
  `
  await addBotAdmin({ number: OWNER, label: "owner", canConnect: true })
  await addBotAdmin({ number: HELPER, label: "helper", canConnect: false })
})

after(async () => {
  await sql`DELETE FROM wa_groups WHERE jid = ${JID}`
  await sql`DELETE FROM wa_admins WHERE number IN (${OWNER}, ${HELPER})`
  await sql`DELETE FROM events WHERE name = ${EVENT}`
  await sql.end()
})

test("a sender's number is read out of the JID however it is shaped", () => {
  assert.equal(senderNumber("628110000001@s.whatsapp.net"), "628110000001")
  assert.equal(senderNumber("628110000001:12@s.whatsapp.net"), "628110000001")
  assert.equal(senderNumber("628110000001@lid"), "628110000001")
  assert.equal(senderNumber(""), "")
})

test("a stranger's command does nothing at all", async () => {
  const result = await runCommand({
    command: { kind: "rekap" },
    groupJid: JID,
    groupName: "Jastip",
    sender: STRANGER,
  })
  assert.deepEqual(result, {}, "no reply, no reaction — a stranger gets silence")
})

test("only a connector may bind a group", async () => {
  const denied = await runCommand({
    command: { kind: "connect" },
    groupJid: JID,
    groupName: "Jastip",
    sender: HELPER,
  })
  assert.deepEqual(denied, {}, "an admin who is not a connector is ignored too")

  const allowed = await runCommand({
    command: { kind: "connect" },
    groupJid: JID,
    groupName: "Jastip",
    sender: OWNER,
  })
  assert.ok(allowed.reply, "the connector gets told what happened")

  const group = (await listGroups()).find((g) => g.jid === JID)
  assert.ok(group, "connecting registers the group even when it cannot pick an event")
  assert.equal(group.name, "Jastip")
})

test("opening a window records the store and reacts rather than replying", async () => {
  await runCommand({
    command: { kind: "connect" },
    groupJid: JID,
    groupName: "Jastip",
    sender: OWNER,
  })

  const result = await runCommand({
    command: { kind: "open", store: "Nishimatsuya" },
    groupJid: JID,
    groupName: "Jastip",
    sender: OWNER,
  })
  assert.ok(result.react, "a reaction, not a message — the group does not need the noise")
  assert.equal(result.reply, undefined)

  const open = await currentCapture(JID)
  assert.equal(open?.store, "Nishimatsuya")
})

test("closing a window ends it", async () => {
  await runCommand({
    command: { kind: "open", store: "Loft" },
    groupJid: JID, groupName: "Jastip", sender: OWNER,
  })
  await runCommand({
    command: { kind: "close" },
    groupJid: JID, groupName: "Jastip", sender: OWNER,
  })
  assert.equal(await currentCapture(JID), null)
})

test("a helper may pull the shopping list but not open a window", async () => {
  const rekap = await runCommand({
    command: { kind: "rekap" },
    groupJid: JID, groupName: "Jastip", sender: HELPER,
  })
  assert.equal(rekap.rekap, true)

  const open = await runCommand({
    command: { kind: "open", store: "Muji" },
    groupJid: JID, groupName: "Jastip", sender: HELPER,
  })
  assert.ok(open.react, "capturing is admin work, and a helper is an admin")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --env-file-if-exists=.env.development.local --test worker/handle-command.test.ts`
Expected: FAIL — cannot resolve `./handle-command`.

- [ ] **Step 3: Implement**

Create `worker/handle-command.ts`:

```typescript
import sql from "@/lib/db-pool"
import {
  bindGroupToEvent, canConnect, closeCapture, isBotAdmin, openCapture, upsertGroup,
} from "@/lib/db/whatsapp-groups"
import type { Command } from "./commands"

export interface CommandResult {
  /** A message to send back. Used only where a reaction cannot carry the answer. */
  reply?: string
  /** A reaction to put on the command message. Cheaper and quieter than a reply. */
  react?: string
  /** The caller should render and send the shopping list. */
  rekap?: true
}

/**
 * The phone number inside a WhatsApp JID.
 *
 * Three shapes turn up: a plain `62…@s.whatsapp.net`, a device-suffixed
 * `62…:12@s.whatsapp.net`, and on newer accounts a privacy identifier ending
 * `@lid`. Only the digits before the separator matter, and taking them keeps
 * this working across all three.
 */
export function senderNumber(jid: string): string {
  const [user] = jid.split("@")
  return (user ?? "").split(":")[0].replace(/\D/g, "")
}

/**
 * Decide what a command should cause, without doing any of the sending.
 *
 * Returning an intent rather than calling the socket keeps the permission model
 * testable, which matters more here than anywhere else in the worker: the whole
 * of "who may do what" lives in this function.
 *
 * An unauthorised sender gets `{}` — no reply, no reaction, nothing. Silence is
 * deliberate. An error message tells a customer that a command exists and
 * invites them to try variations of it.
 */
export async function runCommand(input: {
  command: Command
  groupJid: string
  groupName: string
  sender: string
}): Promise<CommandResult> {
  const number = senderNumber(input.sender)
  if (!(await isBotAdmin(number))) return {}

  switch (input.command.kind) {
    case "connect": {
      // Binding decides where a whole trip's claims land, so it is the
      // connector's alone — not every admin's.
      if (!(await canConnect(number))) return {}

      await upsertGroup({ jid: input.groupJid, name: input.groupName })

      // Bound automatically only when there is exactly one active event. With
      // none there is nothing to choose, and with several a guess would file a
      // trip's claims under the wrong one — so the dashboard decides instead.
      const active = await sql`SELECT name FROM events WHERE is_active ORDER BY id DESC`
      if (active.length === 1) {
        await bindGroupToEvent(input.groupJid, active[0].name as string)
        return { reply: `Connected to ${active[0].name}.` }
      }
      return {
        reply:
          active.length === 0
            ? "Registered. No active event — pick one in the dashboard."
            : `Registered. ${active.length} events are active, so choose one in the dashboard.`,
      }
    }

    case "open":
      await upsertGroup({ jid: input.groupJid, name: input.groupName })
      await openCapture(input.groupJid, input.command.store)
      // A reaction rather than a message: this happens once per shop, in a group
      // full of customers who do not need to read it.
      return { react: "📸" }

    case "close":
      await closeCapture(input.groupJid)
      return { react: "🛑" }

    case "rekap":
      // Any admin. Staff helping run a trip can pull the list without being
      // trusted to re-point the whole event.
      return { rekap: true }
  }
}
```

- [ ] **Step 4: Run the tests and commit**

Run: `npm test`
Expected: PASS — everything, plus six command-handling tests.

```bash
git add worker/handle-command.ts worker/handle-command.test.ts
git commit -m "feat(worker): who may command the bot, and what commands do

runCommand returns an intent rather than sending anything, which keeps the whole
permission model testable without a socket — and permissions are the part of
this worker most worth testing.

An unauthorised sender gets nothing back. Silence is the point: an error message
tells a customer a command exists and invites them to try variations of it.

/connect binds automatically only when exactly one event is active. With none
there is nothing to choose, and with several a guess would file a whole trip's
claims under the wrong event, so the dashboard decides instead."
```

---

### Task 4: Capturing a shelf photo as a post

**Files:**
- Create: `worker/capture.ts`
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes: `currentCapture`, `isBotAdmin` from `lib/db/whatsapp-groups`; `uploadPostImage` from `lib/storage`; `createPost` from `lib/db/claims`; `loadRgb`, `hueHistogram`, `safePenHues` from `lib/claims`; `getProductDefaults` from `lib/db/settings`.
- Produces: `capturePost(input: { sock, message, groupJid, groupName, sender, messageId, caption }): Promise<number | null>` — the new post's id, or null when the image was not a post.

- [ ] **Step 1: Implement**

Create `worker/capture.ts`:

```typescript
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMediaMessage } from "baileys"
import type { WAMessage, WASocket } from "baileys"
import { hueHistogram, loadRgb, safePenHues } from "@/lib/claims"
import { createPost } from "@/lib/db/claims"
import { getProductDefaults } from "@/lib/db/settings"
import { currentCapture, isBotAdmin } from "@/lib/db/whatsapp-groups"
import { uploadPostImage } from "@/lib/storage"
import sql from "@/lib/db-pool"
import { quietLogger } from "./logger"
import { senderNumber } from "./handle-command"

/** Working width for the hue histogram. Only proportions matter. */
const HISTOGRAM_WIDTH = 240

/**
 * Turn a photo the owner sent into a post — if it was one.
 *
 * Three things all have to hold, and returning null for any of them is the
 * normal case rather than an error: the sender is on the admin list, a capture
 * window is open for this group, and the group is bound to an event. That is
 * the whole of what `/mulai` bought — no marker typed per photo, and an
 * ordinary snapshot sent to the group stays an ordinary snapshot.
 *
 * The safe pen hues are computed here, once, and stored on the post. Every reply
 * is then judged against the same answer, rather than each one recomputing it
 * and possibly disagreeing.
 */
export async function capturePost(input: {
  sock: WASocket
  message: WAMessage
  groupJid: string
  messageId: string
  sender: string
  caption: string
}): Promise<number | null> {
  const capture = await currentCapture(input.groupJid)
  if (capture === null) return null
  if (!(await isBotAdmin(senderNumber(input.sender)))) return null

  const [group] = await sql`SELECT event FROM wa_groups WHERE jid = ${input.groupJid}`
  const event = (group?.event as string | null) ?? null
  if (!event) return null

  const buffer = (await downloadMediaMessage(
    input.message,
    "buffer",
    {},
    { logger: quietLogger, reuploadRequest: input.sock.updateMediaMessage },
  )) as Buffer

  // sharp reads a path, and the resolver library takes paths throughout, so the
  // bytes touch disk once here rather than the library growing a second entry
  // point for buffers.
  const dir = await mkdtemp(join(tmpdir(), "wa-post-"))
  const scratch = join(dir, "post.jpg")
  try {
    await writeFile(scratch, buffer)
    const raster = await loadRgb(scratch, HISTOGRAM_WIDTH)
    const hues = safePenHues(hueHistogram(raster), raster.width * raster.height).map((c) => c.hue)

    const path = `${event}/${input.messageId}.jpg`
    await uploadPostImage(path, buffer, "image/jpeg")

    const defaults = await getProductDefaults()
    const { id } = await createPost({
      event,
      imagePath: path,
      imageWidth: raster.width,
      imageHeight: raster.height,
      store: capture.store,
      // Country comes from the event, which is where a trip's currency lives.
      countryId: await countryForEvent(event),
      pricingMethod: defaults.whatsappPricingMethod,
      note: input.caption,
      safeHues: hues,
      messageId: input.messageId,
      groupJid: input.groupJid,
    })
    return id
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The event's country, or null. Naming refuses without one, and says so. */
async function countryForEvent(event: string): Promise<number | null> {
  const [row] = await sql`SELECT country_id FROM events WHERE name = ${event}`
  return (row?.country_id as number | null) ?? null
}
```

- [ ] **Step 2: Wire it into the message loop**

Replace `worker/index.ts`:

```typescript
import type { WAMessage, WASocket } from "baileys"
import { startSession } from "./session"
import { parseCommand } from "./commands"
import { runCommand } from "./handle-command"
import { capturePost } from "./capture"

/** The text of a message, whatever kind it is. */
export function messageText(message: WAMessage): string {
  const content = message.message
  if (!content) return ""
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    ""
  )
}

/** The id of the message this one is replying to, or "". */
export function quotedId(message: WAMessage): string {
  const content = message.message
  return (
    content?.extendedTextMessage?.contextInfo?.stanzaId ??
    content?.imageMessage?.contextInfo?.stanzaId ??
    ""
  )
}

async function onMessage(sock: WASocket, message: WAMessage) {
  // Its own messages come back on this event. Reacting to them would loop.
  if (message.key.fromMe) return

  const groupJid = message.key.remoteJid ?? ""
  if (!groupJid.endsWith("@g.us")) return

  const sender = message.key.participant ?? ""
  const messageId = message.key.id ?? ""
  const text = messageText(message)

  const command = parseCommand(text)
  if (command) {
    const result = await runCommand({
      command,
      groupJid,
      groupName: (await sock.groupMetadata(groupJid).catch(() => null))?.subject ?? "",
      sender,
    })
    if (result.react) {
      await sock.sendMessage(groupJid, { react: { text: result.react, key: message.key } })
    }
    if (result.reply) await sock.sendMessage(groupJid, { text: result.reply })
    // Rendering and sending the shopping list arrives in task 6.
    return
  }

  const isImage = Boolean(message.message?.imageMessage)
  if (!isImage) return

  // An image that quotes something is a customer pointing at a post; one that
  // quotes nothing, from an admin, inside an open window, is a new shelf.
  if (quotedId(message) === "") {
    await capturePost({ sock, message, groupJid, messageId, sender, caption: text })
  }
  // Claims arrive in task 5.
}

async function main() {
  await startSession((sock) => {
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return
      for (const message of messages) {
        try {
          await onMessage(sock, message)
        } catch (err) {
          // One bad message must not take the socket down with it.
          console.error("failed to handle a message:", err)
        }
      }
    })
  })
}

main().catch((err) => {
  console.error("worker failed to start:", err)
  process.exit(1)
})
```

- [ ] **Step 3: Verify against a real group**

```bash
npx tsc --noEmit
npm run worker
```

From the owner's own phone in a test group containing the bot:

1. Send `/connect` — expect a reply naming the event, or telling you to pick one.
2. Send `/mulai Nishimatsuya` — expect a 📸 reaction.
3. Send a shelf photo with no caption.
4. Check it landed:

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT id, store, event, array_length(safe_hues,1) AS hues, message_id <> '' AS has_msg FROM wa_posts ORDER BY id DESC LIMIT 3;"
```

Expected: a row with the store, the event, some hues and `has_msg = t`.

5. Send `/selesai`, then another photo, and confirm **no** new row appears —
   that is the whole point of the window.

- [ ] **Step 4: Commit**

```bash
git add worker/capture.ts worker/index.ts
git commit -m "feat(worker): capture a shelf photo as a post

Three things must hold and none of them is typed per photo: the sender is on the
admin list, a window is open, and the group is bound to an event. That is what
/mulai buys — an ordinary snapshot sent to the group stays an ordinary snapshot,
with no marker to remember.

Safe pen hues are computed once here and stored on the post, so every reply is
judged against the same answer instead of each recomputing one and disagreeing.

One bad message never takes the socket down: the loop catches per message."
```

---

### Task 5: Capturing claims, and acknowledging them

**Files:**
- Create: `worker/reactions.ts`
- Create: `worker/reactions.test.ts`
- Create: `worker/claims.ts`
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes: `ingestImageReply`, `recluster` from `lib/whatsapp/ingest`; `resolveSenders` from `lib/whatsapp/identity`; `findPostByMessage`, `addClaim`, `listClaims` from `lib/db/claims`; `resolveText`, `parseVariantNote`, `normalizeSize` from `lib/claims`.
- Produces:
  - `ReactionQueue` — a serial, jittered sender.
  - `CAPTURE_REACTIONS` — the spec's vocabulary as constants.
  - `captureClaim(input): Promise<string>` — the emoji the claim earned.

- [ ] **Step 1: Write the failing test**

Create `worker/reactions.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { CAPTURE_REACTIONS, OUTCOME_REACTIONS, ReactionQueue } from "./reactions"

test("the vocabulary is the one the spec fixed", () => {
  assert.equal(CAPTURE_REACTIONS.recorded, "📝")
  assert.equal(CAPTURE_REACTIONS.needsDetail, "❔")
  assert.equal(CAPTURE_REACTIONS.unreadable, "😢")
  assert.equal(OUTCOME_REACTIONS.secured, "✅")
  assert.equal(OUTCOME_REACTIONS.missed, "❌")
})

test("reactions go out one at a time, never in a volley", async () => {
  const sent: number[] = []
  let inFlight = 0
  let overlapped = false

  const queue = new ReactionQueue(
    async () => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      sent.push(sent.length)
    },
    // No jitter in the test: the pacing is the caller's concern, the ordering
    // is this class's.
    () => 0,
  )

  for (let i = 0; i < 5; i++) queue.push({ jid: "g@g.us", key: { id: String(i) }, emoji: "📝" })
  await queue.drain()

  assert.equal(sent.length, 5)
  assert.equal(overlapped, false, "a volley of reactions is the signature to avoid")
})

test("a failed reaction does not stop the ones behind it", async () => {
  let attempts = 0
  const queue = new ReactionQueue(async () => {
    attempts += 1
    if (attempts === 2) throw new Error("network")
  }, () => 0)

  for (let i = 0; i < 3; i++) queue.push({ jid: "g@g.us", key: { id: String(i) }, emoji: "📝" })
  await queue.drain()

  assert.equal(attempts, 3, "the queue keeps going after one fails")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --test worker/reactions.test.ts`
Expected: FAIL — cannot resolve `./reactions`.

- [ ] **Step 3: Implement the queue**

Create `worker/reactions.ts`:

```typescript
import type { WAMessageKey } from "baileys"

/** What a claim earns at capture time. From the spec; do not invent others. */
export const CAPTURE_REACTIONS = {
  recorded: "📝",
  needsDetail: "❔",
  unreadable: "😢",
} as const

/** What it earns once the owner has been to the shop. */
export const OUTCOME_REACTIONS = {
  secured: "✅",
  missed: "❌",
} as const

export interface QueuedReaction {
  jid: string
  key: WAMessageKey
  emoji: string
}

/** Milliseconds between reactions, before jitter. */
const BASE_DELAY_MS = 1500
/** Extra random delay, so the gaps are not identical. */
const JITTER_MS = 2500

/**
 * Send reactions one at a time, slowly.
 *
 * Recording a purchase flips every claim behind it at once — forty items is
 * forty reactions. Firing those as fast as the socket allows is precisely the
 * automated signature this number must not exhibit, so they are serialised and
 * spaced with jitter. Nothing here is time-critical: a customer learning their
 * outcome a minute later than possible costs nothing.
 *
 * A failure never stops the queue. The most common one is a message too old to
 * react to, and letting that strand the forty behind it would be worse than
 * losing one acknowledgement.
 */
export class ReactionQueue {
  private queue: QueuedReaction[] = []
  private running = false
  private idle: Promise<void> = Promise.resolve()
  private resolveIdle: (() => void) | null = null

  constructor(
    private readonly send: (reaction: QueuedReaction) => Promise<void>,
    private readonly delay: () => number = () => BASE_DELAY_MS + Math.random() * JITTER_MS,
  ) {}

  push(reaction: QueuedReaction): void {
    this.queue.push(reaction)
    if (!this.running) {
      this.idle = new Promise((resolve) => {
        this.resolveIdle = resolve
      })
      this.running = true
      void this.run()
    }
  }

  /** Resolves when everything queued so far has been attempted. */
  drain(): Promise<void> {
    return this.idle
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0) {
      const next = this.queue.shift() as QueuedReaction
      try {
        await this.send(next)
      } catch (err) {
        console.error("failed to send a reaction:", err)
      }
      const wait = this.delay()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    }
    this.running = false
    this.resolveIdle?.()
    this.resolveIdle = null
  }
}
```

- [ ] **Step 4: Implement claim capture**

Create `worker/claims.ts`:

```typescript
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadMediaMessage } from "baileys"
import type { WAMessage, WASocket } from "baileys"
import { normalizeSize } from "@/lib/claims"
import { addClaim, findPostByMessage, listClaims, type WaPost } from "@/lib/db/claims"
import { ingestImageReply, recluster } from "@/lib/whatsapp/ingest"
import { resolveSenders } from "@/lib/whatsapp/identity"
import { quietLogger } from "./logger"
import { CAPTURE_REACTIONS } from "./reactions"

/**
 * Record what a customer's reply is claiming, and say which reaction it earned.
 *
 * An image reply goes through the resolver — marks, a crop, or the whole photo
 * sent back. A text reply is a claim only when it names something the photo
 * cannot show, which for a shelf means a size; anything else is chatter, and
 * reacting to chatter would train customers that the bot reads everything.
 *
 * Nothing is ever dropped for being unreadable. 😢 is a request to retype, and
 * the claim behind it is still recorded in review so the owner can rescue it.
 */
export async function captureClaim(input: {
  sock: WASocket
  message: WAMessage
  post: WaPost
  sender: string
  messageId: string
  text: string
  isImage: boolean
}): Promise<string | null> {
  if (input.isImage) return captureImageClaim(input)

  const size = normalizeSize(input.text)
  if (!size) return null

  await addClaim({
    postId: input.post.id,
    sender: input.sender,
    customer: null,
    source: "text",
    point: null,
    variantId: null,
    quantity: 1,
    note: input.text,
    confidence: 0.6,
    // A size with no position says WHAT but not WHICH, so a human picks the slot.
    state: "review",
    messageId: input.messageId,
  })
  await resolveSenders(input.post.id)
  return CAPTURE_REACTIONS.needsDetail
}

async function captureImageClaim(input: {
  sock: WASocket
  message: WAMessage
  post: WaPost
  sender: string
  messageId: string
  text: string
}): Promise<string> {
  const buffer = (await downloadMediaMessage(
    input.message,
    "buffer",
    {},
    { logger: quietLogger, reuploadRequest: input.sock.updateMediaMessage },
  )) as Buffer

  const dir = await mkdtemp(join(tmpdir(), "wa-reply-"))
  const scratch = join(dir, "reply.jpg")
  try {
    await writeFile(scratch, buffer)
    const { claimIds } = await ingestImageReply({
      postId: input.post.id,
      sender: input.sender,
      messageId: input.messageId,
      replyPath: scratch,
      caption: input.text,
    })
    await resolveSenders(input.post.id)
    await recluster(input.post.id)

    // The reply image itself is deliberately not kept — the spec discards them
    // once the claim is recorded, and the group chat is the audit trail.
    const claims = await listClaims(input.post.id)
    const mine = claims.filter((c) => claimIds.includes(c.id))

    if (mine.length === 0) return CAPTURE_REACTIONS.unreadable
    if (mine.some((c) => c.state === "review")) return CAPTURE_REACTIONS.needsDetail
    return CAPTURE_REACTIONS.recorded
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The post a reply is pointing at, or null when it quotes something else. */
export async function postForReply(
  groupJid: string,
  quoted: string,
): Promise<WaPost | null> {
  return findPostByMessage(groupJid, quoted)
}
```

- [ ] **Step 5: Wire it in**

In `worker/index.ts`, add the imports:

```typescript
import { captureClaim, postForReply } from "./claims"
import { ReactionQueue } from "./reactions"
```

Create the queue once per process, above `main`:

```typescript
let reactions: ReactionQueue | null = null
```

and in `startSession`'s callback, before attaching the message handler:

```typescript
    reactions = new ReactionQueue(async ({ jid, key, emoji }) => {
      await sock.sendMessage(jid, { react: { text: emoji, key } })
    })
```

Then replace the tail of `onMessage` — everything after the command block —
with:

```typescript
  const isImage = Boolean(message.message?.imageMessage)
  const quoted = quotedId(message)

  // An image that quotes nothing, from an admin, inside an open window, is a
  // new shelf. Everything else that quotes a post is somebody claiming.
  if (isImage && quoted === "") {
    await capturePost({ sock, message, groupJid, messageId, sender, caption: text })
    return
  }
  if (quoted === "") return

  const post = await postForReply(groupJid, quoted)
  if (post === null) return

  const emoji = await captureClaim({
    sock, message, post, sender, messageId, text, isImage,
  })
  if (emoji) reactions?.push({ jid: groupJid, key: message.key, emoji })
```

- [ ] **Step 6: Run the tests, then try it for real**

Run: `npm test`
Expected: PASS — everything, plus three reaction tests.

```bash
npx tsc --noEmit
npm run worker
```

From a second phone in the test group, reply to the shelf photo with a marked-up
copy of it. Expect a 📝 within a few seconds, and:

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT id, source, state, customer, sender FROM wa_claims ORDER BY id DESC LIMIT 5;"
```

Expected: one claim per mark, `source = ink`.

- [ ] **Step 7: Commit**

```bash
git add worker/reactions.ts worker/reactions.test.ts worker/claims.ts worker/index.ts
git commit -m "feat(worker): capture claims and acknowledge them

An image reply goes through the resolver; a text reply is a claim only when it
names a size, because reacting to ordinary chatter would teach customers the bot
reads everything they type.

Nothing is dropped for being unreadable. The sad face asks for a retype and the
claim behind it is still recorded in review, so the owner can rescue it rather
than it reaching nobody.

Reactions are serialised and spaced with jitter. Recording a purchase flips
every claim behind it — forty items is forty reactions — and firing those as
fast as the socket allows is exactly the automated signature this number must
not exhibit. A failure never stops the queue: the usual one is a message too old
to react to, and stranding the rest behind it would be worse."
```

---

### Task 6: The owner's reactions, the outcome sweep, and `/rekap`

**Files:**
- Create: `worker/outcomes.ts`
- Create: `worker/outcomes.test.ts`
- Modify: `worker/index.ts`

**Interfaces:**
- Consumes: `markClaimObtained`, `listClaims`, `listSlots` from `lib/db/claims`; `isBotAdmin` from `lib/db/whatsapp-groups`; `renderShoppingList` from `lib/whatsapp/render`.
- Produces:
  - `classifyOwnerReaction(emoji: string): "bought" | "missed" | null`
  - `applyOwnerReaction(input): Promise<boolean>`
  - `outcomeFor(claim): string | null` — which reaction a claim should now carry.

- [ ] **Step 1: Write the failing test**

Create `worker/outcomes.test.ts`:

```typescript
import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyOwnerReaction, outcomeFor } from "./outcomes"

test("the owner's tick means bought and their cross means not", () => {
  assert.equal(classifyOwnerReaction("✅"), "bought")
  assert.equal(classifyOwnerReaction("☑️"), "bought")
  assert.equal(classifyOwnerReaction("❌"), "missed")
  assert.equal(classifyOwnerReaction("✖️"), "missed")
})

test("the bot's own capture vocabulary is not an instruction", () => {
  // 📝 and ❔ are what the BOT puts on a claim. Reading them back as the owner
  // saying something would make the bot answer itself.
  assert.equal(classifyOwnerReaction("📝"), null)
  assert.equal(classifyOwnerReaction("❔"), null)
  assert.equal(classifyOwnerReaction("😢"), null)
})

test("an unrelated reaction means nothing", () => {
  assert.equal(classifyOwnerReaction("😂"), null)
  assert.equal(classifyOwnerReaction(""), null)
})

test("a claim's outcome follows what it obtained", () => {
  assert.equal(outcomeFor({ quantity: 1, obtained: 1, state: "assigned" }), "✅")
  assert.equal(outcomeFor({ quantity: 2, obtained: 2, state: "assigned" }), "✅")
  assert.equal(outcomeFor({ quantity: 2, obtained: 1, state: "assigned" }), "✅",
    "partly filled still means something is theirs")
  assert.equal(outcomeFor({ quantity: 1, obtained: 0, state: "assigned" }), null,
    "nothing bought yet is not the same as missing out")
})

test("a rejected claim is a cross, whatever it obtained", () => {
  assert.equal(outcomeFor({ quantity: 1, obtained: 0, state: "rejected" }), "❌")
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx --test worker/outcomes.test.ts`
Expected: FAIL — cannot resolve `./outcomes`.

- [ ] **Step 3: Implement**

Create `worker/outcomes.ts`:

```typescript
import sql from "@/lib/db-pool"
import { markClaimObtained } from "@/lib/db/claims"
import { isBotAdmin } from "@/lib/db/whatsapp-groups"
import { OUTCOME_REACTIONS } from "./reactions"
import { senderNumber } from "./handle-command"

/** Ticks and crosses the owner might reach for, including the variant selectors. */
const BOUGHT = new Set(["✅", "☑️", "✔️", "✔", "☑"])
const MISSED = new Set(["❌", "✖️", "✖", "❎"])

/**
 * What the owner meant by reacting to a claim.
 *
 * Only ticks and crosses. The bot's own capture vocabulary — 📝 ❔ 😢 — is
 * deliberately excluded: those are what the bot puts ON a claim, and reading
 * them back as an instruction would have it answering itself.
 */
export function classifyOwnerReaction(emoji: string): "bought" | "missed" | null {
  if (BOUGHT.has(emoji)) return "bought"
  if (MISSED.has(emoji)) return "missed"
  return null
}

/**
 * Apply the owner's tick to the claim they put it on.
 *
 * A tick buys that claim's whole quantity — someone who asked for two gets both.
 * If only one of their two was found, the stepper in the shop screen is the
 * right tool; a reaction cannot carry a number.
 *
 * Returns false when the reaction was not the owner's to give, which is the
 * common case: customers react to each other's messages all day.
 */
export async function applyOwnerReaction(input: {
  reactorJid: string
  messageId: string
  emoji: string
}): Promise<boolean> {
  const intent = classifyOwnerReaction(input.emoji)
  if (intent === null) return false
  if (!(await isBotAdmin(senderNumber(input.reactorJid)))) return false

  const [claim] = await sql`
    SELECT id, quantity FROM wa_claims
    WHERE message_id = ${input.messageId} AND state <> 'rejected'
    ORDER BY id ASC
  `
  if (!claim) return false

  await markClaimObtained(
    claim.id as number,
    intent === "bought" ? (claim.quantity as number) : 0,
  )
  if (intent === "missed") {
    await sql`UPDATE wa_claims SET state = 'rejected', updated_at = NOW() WHERE id = ${claim.id}`
  }
  return true
}

/**
 * Which reaction a claim should now carry, or null to leave it alone.
 *
 * Zero obtained is not a cross. Before the owner reaches the shop every claim
 * has obtained zero, and telling forty customers they missed out because nobody
 * has gone shopping yet would be worse than saying nothing.
 */
export function outcomeFor(claim: {
  quantity: number
  obtained: number
  state: string
}): string | null {
  if (claim.state === "rejected") return OUTCOME_REACTIONS.missed
  if (claim.obtained > 0) return OUTCOME_REACTIONS.secured
  return null
}
```

- [ ] **Step 4: Wire reactions and `/rekap` in**

In `worker/index.ts`, add:

```typescript
import { applyOwnerReaction, outcomeFor } from "./outcomes"
import { listClaims } from "@/lib/db/claims"
import { renderShoppingList } from "@/lib/whatsapp/render"
import sql from "@/lib/db-pool"
```

In the command block, replace the `// Rendering and sending…` comment with:

```typescript
    if (result.rekap) await sendRekap(sock, groupJid)
```

and add these two functions above `main`:

```typescript
/**
 * Post the shopping list for this group's newest shelf.
 *
 * Newest rather than a chosen one: `/rekap` is typed one-handed in a shop, and
 * the shelf in front of the owner is the one they just posted. Older shelves are
 * a scroll away in the dashboard.
 */
async function sendRekap(sock: WASocket, groupJid: string) {
  const [post] = await sql`
    SELECT id FROM wa_posts WHERE group_jid = ${groupJid} ORDER BY id DESC LIMIT 1
  `
  if (!post) {
    await sock.sendMessage(groupJid, { text: "No shelf posted here yet." })
    return
  }
  const image = await renderShoppingList(post.id as number)
  await sock.sendMessage(groupJid, { image, caption: "" })
}

/**
 * Move every claim on a post to the reaction its outcome now deserves.
 *
 * Run after the owner's tick lands, because one tick can change one claim but a
 * short allocation changes several — the person who lost their unit needs their
 * cross without anybody composing a message.
 */
async function sweepOutcomes(groupJid: string, postId: number) {
  for (const claim of await listClaims(postId)) {
    const emoji = outcomeFor(claim)
    if (!emoji || !claim.messageId) continue
    reactions?.push({
      jid: groupJid,
      key: { remoteJid: groupJid, id: claim.messageId, fromMe: false },
      emoji,
    })
  }
}
```

Then attach the reaction listener inside `startSession`'s callback, beside the
message handler:

```typescript
    sock.ev.on("messages.reaction", async (events) => {
      for (const event of events) {
        try {
          const groupJid = event.key.remoteJid ?? ""
          if (!groupJid.endsWith("@g.us")) continue

          // reaction.key is the REACTOR's key; event.key is the message reacted
          // to. Skipping the bot's own stops it reading its own 📝 back.
          if (event.reaction.key?.fromMe) continue

          const applied = await applyOwnerReaction({
            reactorJid: event.reaction.key?.participant ?? "",
            messageId: event.key.id ?? "",
            emoji: event.reaction.text ?? "",
          })
          if (!applied) continue

          const [claim] = await sql`
            SELECT post_id FROM wa_claims WHERE message_id = ${event.key.id ?? ""} LIMIT 1
          `
          if (claim) await sweepOutcomes(groupJid, claim.post_id as number)
        } catch (err) {
          console.error("failed to handle a reaction:", err)
        }
      }
    })
```

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS — everything, plus five outcome tests.

- [ ] **Step 6: Try the whole loop for real**

```bash
npx tsc --noEmit
npm run worker
```

1. `/mulai Nishimatsuya`, post a shelf photo.
2. From a second phone, reply with a marked-up copy — expect 📝.
3. From the owner's phone, react ✅ to that customer's message.
4. Expect the same message to gain a ✅ from the bot within a few seconds, and:

```bash
PSQL=psql; [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "SELECT id, quantity, obtained, state FROM wa_claims ORDER BY id DESC LIMIT 5;"
```

Expected: `obtained = quantity` on the claim you ticked.

5. Send `/rekap` — expect the annotated shelf photo posted back to the group.
6. From a phone that is **not** on the admin list, send `/rekap` — expect
   nothing at all, not even an error.

- [ ] **Step 7: Commit**

```bash
git add worker/outcomes.ts worker/outcomes.test.ts worker/index.ts
git commit -m "feat(worker): read the owner's ticks, sweep outcomes, answer /rekap

A tick from an admin buys that claim's whole quantity; a cross closes it. Only
ticks and crosses count — the bot's own capture vocabulary is excluded, or it
would read its own notes back as instructions and answer itself.

Zero obtained is deliberately not a cross. Before the owner reaches the shop
every claim has obtained zero, and telling forty customers they missed out
because nobody has gone shopping yet is worse than saying nothing.

One tick can change several claims, because a short allocation moves units
between people, so the whole post is swept afterwards — the customer who lost a
unit gets their cross without anyone composing a message.

/rekap renders the newest shelf in the group. It is typed one-handed in a shop,
and the shelf in front of the owner is the one they just posted."
```

---

## What this plan does not build

- **Substitution questions.** The owner asks them, in their own words, from
  their own number — the spec's one firm rule about what the bot never does. The
  bot only captures the answer, which arrives as a reply or a reaction on a
  claim already in review.
- **Auto-closing a stale capture window.** The window closes on `/selesai`. A
  timer is a small addition and belongs after the owner has seen how often they
  forget.
- **Reading video posts.** Shelf photos are the case; a video post would need
  frame extraction before the resolver could touch it.
- **Any hosting.** The worker is a process. Where it runs is the operational
  choice named at the top of this plan.

## Open question for whoever runs this

Newer WhatsApp accounts identify participants by a privacy id ending `@lid`
rather than a phone number. `senderNumber` strips both to digits, but a `@lid`
value is **not** the person's phone number, so `wa_admins` and
`customers.whatsapp` would not match it. Confirm during Task 4 that the numbers
logged for real senders look like real phone numbers; if they do not, the admin
list needs to store the lid alongside the number, and `findCustomerByNumber`
needs the same.

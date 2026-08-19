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
export async function startSession(onReady: (sock: WASocket) => void): Promise<void> {
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

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

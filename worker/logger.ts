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

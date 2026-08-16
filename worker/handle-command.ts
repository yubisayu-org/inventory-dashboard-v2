import sql from "@/lib/db-pool"
import {
  bindGroupToEvent, canConnect, closeCapture, isBotAdmin, openCapture, upsertGroup,
} from "@/lib/db/whatsapp-groups"
import type { WAMessageKey } from "baileys"
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
 * The JID that identifies a person, preferring one that carries their number.
 *
 * WhatsApp increasingly hands out a privacy identifier — `104428539535560@lid`
 * — as a message's participant. That is stable per account but is NOT a phone
 * number, so looking it up against wa_admins or customers.whatsapp always
 * misses, and every lookup in this worker fails closed and silently. The real
 * number arrives alongside it as participantPn / senderPn, so prefer those and
 * fall back to participant for accounts that still send a plain JID.
 */
export function senderJid(key: WAMessageKey | null | undefined): string {
  if (!key) return ""
  const alt = (key as { participantAlt?: string }).participantAlt
  return key.participantPn ?? key.senderPn ?? alt ?? key.participant ?? ""
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

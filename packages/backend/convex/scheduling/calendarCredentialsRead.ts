// B1 — internal read query for calendarCredentials rows.
//
// Convex actions cannot read the DB directly; the Google provider actions in
// `googleCalendar.ts` load the (encrypted) credential row through this
// `internalQuery`, then decrypt it in-action via `_helpers/cryptoEnvelope`. The
// decrypted secret NEVER crosses a function boundary — only the encrypted
// envelope fields travel here, and decryption happens inside the calling
// action's V8 isolate.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

/** Shape returned to the action — the encrypted envelope + provider metadata. */
export interface CalendarCredentialRow {
  _id: Id<"calendarCredentials">;
  provider: "google" | "caldav";
  encSecretCiphertext: string;
  encSecretIv: string;
  caldavServerUrl?: string;
  caldavUsername?: string;
  invalid: boolean;
}

export async function getCredentialRowHandler(
  ctx: Ctx,
  args: { credentialId: Id<"calendarCredentials"> },
): Promise<CalendarCredentialRow | null> {
  const row = await ctx.db.get(args.credentialId);
  if (!row) return null;
  return {
    _id: row._id,
    provider: row.provider,
    encSecretCiphertext: row.encSecretCiphertext,
    encSecretIv: row.encSecretIv,
    caldavServerUrl: row.caldavServerUrl,
    caldavUsername: row.caldavUsername,
    invalid: row.invalid,
  };
}

export const getCredentialRow = internalQuery({
  args: { credentialId: v.id("calendarCredentials") },
  handler: getCredentialRowHandler,
});

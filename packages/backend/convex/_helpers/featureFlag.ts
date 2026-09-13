// Feature flags for the standalone booking backend. Lifted contract from the
// dibslist helper (same exports, same `featureFlags` table shape) with ONE
// deliberate difference: a flag with NO row defaults to ON, regardless of the
// `defaultValue` the caller passes. The lifted booking code gates every write
// on `booking_enabled` with `defaultValue: false` (a launch gate for a shared
// marketplace deployment); on a single-owner standalone deployment the
// surface must simply be live on first deploy. An operator can still turn a
// flag OFF by inserting `{ key, value: false }` — the kill switch is real.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

export type FeatureFlagKey = string;

export interface FeatureFlagRow {
  key: string;
  value: boolean;
  updatedAt: number;
  updatedBy: string;
  reason?: string;
}

/** Pure verdict: an explicit row wins; no row → ON. */
export function flagVerdict({
  row,
}: {
  row: { value?: boolean } | null | undefined;
  defaultValue: boolean;
}): boolean {
  if (!row || typeof row.value !== "boolean") return true;
  return row.value;
}

const FLAG_CACHE = new WeakMap<object, Map<string, boolean>>();

export async function isFlagEnabled(
  ctx: Ctx,
  key: FeatureFlagKey,
  defaultValue: boolean,
): Promise<boolean> {
  let perCtx = FLAG_CACHE.get(ctx as object);
  if (!perCtx) {
    perCtx = new Map<string, boolean>();
    FLAG_CACHE.set(ctx as object, perCtx);
  }
  const cached = perCtx.get(key);
  if (cached !== undefined) return cached;

  let row: { value?: boolean } | null = null;
  if (ctx && typeof ctx === "object" && "db" in ctx && ctx.db) {
    try {
      row = await ctx.db
        .query("featureFlags")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex("by_key", (q: any) => q.eq("key", key))
        .unique();
    } catch {
      row = null;
    }
  }
  const verdict = flagVerdict({ row, defaultValue });
  perCtx.set(key, verdict);
  return verdict;
}

export type FlagGateResult =
  | { ok: true }
  | { ok: false; kind: string; message: string };

export async function requireFlagEnabled(
  ctx: Ctx,
  key: FeatureFlagKey,
  opts: { kind: string; message: string; defaultValue?: boolean },
): Promise<FlagGateResult> {
  const enabled = await isFlagEnabled(ctx, key, opts.defaultValue ?? true);
  if (enabled) return { ok: true };
  return { ok: false, kind: opts.kind, message: opts.message };
}

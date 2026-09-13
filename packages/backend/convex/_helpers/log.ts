// Minimal structured logger with the same surface the lifted modules use.
// The *Db variants in dibslist also mirrored rows into a recentErrors table;
// here they just log (the table exists but nothing reads it).
type LogContext = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function formatContext(c?: LogContext): string {
  return c && Object.keys(c).length ? ` ${safeStringify(c)}` : "";
}
function formatError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: safeStringify(err) };
}

export const log = {
  info(event: string, context?: LogContext): void {
    console.log(`[INFO] ${event}${formatContext(context)}`);
  },
  warn(event: string, context?: LogContext): void {
    console.warn(`[WARN] ${event}${formatContext(context)}`);
  },
  error(event: string, err?: unknown, context?: LogContext): void {
    if (err === undefined) {
      console.error(`[ERROR] ${event}${formatContext(context)}`);
      return;
    }
    const { message, stack } = formatError(err);
    const merged: LogContext = { ...context, err: message };
    if (stack) merged.stack = stack;
    console.error(`[ERROR] ${event}${formatContext(merged)}`);
  },
  async errorDb(_ctx: Ctx, event: string, err?: unknown, context?: LogContext): Promise<void> {
    log.error(event, err, context);
  },
  async warnDb(_ctx: Ctx, event: string, context?: LogContext): Promise<void> {
    log.warn(event, context);
  },
  async criticalDb(_ctx: Ctx, event: string, err?: unknown, context?: LogContext): Promise<void> {
    log.error(event, err, context);
  },
};

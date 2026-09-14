import { APP_NAME } from "@calcom/lib/constants";

export const dynamic = "force-dynamic";

// Owner sign-in: one password, one account. Plain server-rendered form posting
// to /api/auth/owner-login (no client JS, no NextAuth).
export default async function OwnerLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/dash";
  const error = sp.error !== undefined;

  return (
    <div className="light flex min-h-screen w-full items-center justify-center bg-cal-muted p-6">
      <form
        method="POST"
        action="/api/auth/owner-login"
        className="w-full max-w-sm rounded-xl border border-subtle bg-default p-8 shadow-sm">
        <h1 className="font-bold text-2xl text-emphasis">{APP_NAME}</h1>
        <p className="mt-1 text-subtle text-sm">Owner sign-in</p>

        <input type="hidden" name="next" value={next} />

        <label className="mt-6 block font-medium text-emphasis text-sm" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          className="mt-1 h-10 w-full rounded-md border border-subtle bg-default px-3 text-emphasis text-sm outline-none focus:border-emphasis"
        />
        {error && <p className="mt-2 text-error text-sm">Wrong password.</p>}

        <button
          type="submit"
          className="mt-6 h-10 w-full rounded-md bg-[#111827] font-medium text-sm text-white transition hover:opacity-90">
          Sign in
        </button>
      </form>
    </div>
  );
}

// Standalone single-owner auth. There is no user database: every authed
// Convex call acts as the one owner account. The Cal.com fork resolves the
// owner via its own cookie (OWNER_PASSWORD login) and passes `authUserId`
// explicitly to the s2s admin functions, which is why this can be a constant.
export const OWNER_AUTH_USER_ID = "owner";

// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
export async function requireAuthUserId(_ctx: any): Promise<string> {
  return OWNER_AUTH_USER_ID;
}

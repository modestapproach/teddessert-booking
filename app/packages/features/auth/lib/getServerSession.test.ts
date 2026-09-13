// CV-1 — tests for the dibslist-backed `getServerSession`.
//
// The original next-auth/Prisma-path tests are obsolete: getServerSession now
// validates the dibslist Better-Auth cookie (via `validateDibslistSession`) and
// mints a stable integer cal id (via the Convex `resolveOrCreateCalcomUser`
// mutation through `getConvex()`), then returns the cal `Session` shape. These
// tests mock those two collaborators and assert the produced Session shape.

import type { NextApiRequest } from "next";
import { createMocks } from "node-mocks-http";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Better-Auth validation + the Convex client + avatar/logger helpers.
const validateMock = vi.fn();
const mutationMock = vi.fn();

vi.mock("./dibslistSession", () => ({
  validateDibslistSession: (...args: unknown[]) => validateMock(...args),
}));
vi.mock("@calcom/lib/server/convex", () => ({
  getConvex: () => ({ mutation: (...args: unknown[]) => mutationMock(...args) }),
}));
vi.mock("@calcom/lib/getAvatarUrl", () => ({
  getUserAvatarUrl: ({ avatarUrl }: { avatarUrl?: string | null }) =>
    avatarUrl ?? "/default-avatar.png",
}));
vi.mock("@calcom/lib/logger", () => ({
  default: { getSubLogger: () => ({ debug() {}, warn() {}, error() {} }) },
}));
vi.mock("@calcom/lib/safeStringify", () => ({ safeStringify: (x: unknown) => JSON.stringify(x) }));

import { getServerSession } from "./getServerSession";

type MockNextApiRequest = ReturnType<typeof createMocks<NextApiRequest>>["req"];

function reqWithCookie(cookie?: string): MockNextApiRequest {
  const { req } = createMocks<NextApiRequest>({ method: "GET" });
  if (cookie) (req.headers as Record<string, string>).cookie = cookie;
  return req;
}

const COOKIE = "better-auth.session_token=abc.def; other=1";

describe("getServerSession (dibslist-backed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there is no cookie header", async () => {
    const result = await getServerSession({ req: reqWithCookie(undefined) });
    expect(result).toBeNull();
    expect(validateMock).not.toHaveBeenCalled();
  });

  it("returns null when the dibslist session is invalid (fail-closed)", async () => {
    validateMock.mockResolvedValue(null);
    const result = await getServerSession({ req: reqWithCookie(COOKIE) });
    expect(result).toBeNull();
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("returns null when minting the cal id fails (fail-closed)", async () => {
    validateMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "jane@dibslist.app", name: "Jane", emailVerified: true },
    });
    mutationMock.mockRejectedValue(new Error("convex down"));
    const result = await getServerSession({ req: reqWithCookie(COOKIE) });
    expect(result).toBeNull();
  });

  it("produces the cal Session shape with an INTEGER user.id", async () => {
    validateMock.mockResolvedValue({
      session: { id: "s1", userId: "u1", expiresAt: "2030-01-01T00:00:00.000Z" },
      user: {
        id: "betterauth_u1",
        email: "Jane.Doe@dibslist.app",
        name: "Jane Doe",
        emailVerified: true,
        image: "https://cdn/jane.png",
      },
    });
    mutationMock.mockResolvedValue({ calId: 42, _id: "calcomUserMap|1", created: true });

    const result = await getServerSession({ req: reqWithCookie(COOKIE) });

    expect(result).not.toBeNull();
    // Integer id — the critical cal contract.
    expect(typeof result!.user.id).toBe("number");
    expect(result!.user.id).toBe(42);
    expect(result!.user.uuid).toBe("betterauth_u1");
    expect(result!.user.email).toBe("Jane.Doe@dibslist.app");
    expect(result!.user.name).toBe("Jane Doe");
    expect(result!.user.role).toBe("USER");
    expect(result!.user.email_verified).toBe(true);
    expect(result!.user.emailVerified).toBeInstanceOf(Date);
    expect(result!.user.image).toBe("https://cdn/jane.png");
    expect(result!.user.belongsToActiveTeam).toBe(false);
    expect(result!.user.org).toBeUndefined();
    expect(result!.hasValidLicense).toBe(false);
    expect(result!.profileId).toBeNull();
    expect(result!.upId).toBe("usr-42");
    // UserAsPersonalProfile (no org).
    expect(result!.user.profile).toMatchObject({
      id: null,
      upId: "usr-42",
      organizationId: null,
      organization: null,
    });
    expect(result!.expires).toBe(new Date("2030-01-01T00:00:00.000Z").toISOString());

    // The mutation got the dibslist authUserId + email.
    expect(mutationMock).toHaveBeenCalledTimes(1);
    const [, args] = mutationMock.mock.calls[0];
    expect(args).toMatchObject({ authUserId: "betterauth_u1", email: "Jane.Doe@dibslist.app" });
  });

  it("caches the constructed session by session token (no re-validate on second call)", async () => {
    validateMock.mockResolvedValue({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "jane@dibslist.app", name: "Jane", emailVerified: true },
    });
    mutationMock.mockResolvedValue({ calId: 7, _id: "calcomUserMap|1", created: true });

    const a = await getServerSession({ req: reqWithCookie("better-auth.session_token=TOKEN_X") });
    const b = await getServerSession({ req: reqWithCookie("better-auth.session_token=TOKEN_X") });
    expect(a!.user.id).toBe(7);
    expect(b!.user.id).toBe(7);
    // Second call served from cache → validate called only once.
    expect(validateMock).toHaveBeenCalledTimes(1);
  });
});

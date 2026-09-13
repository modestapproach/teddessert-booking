import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { authedProcedure } from "../../../procedures/authedProcedure";

// CV-9 — the createEventPbacProcedure middleware was REWIRED off prisma onto the
// owner-scoped Convex ownership check (`checkOwnerEventTypeOwnership`). The previous
// tests in this file asserted the OLD prisma behavior — they mocked
// `ctx.prisma.eventType.findUnique` and exercised the team/PermissionCheckService
// branches (DEAD in the dibslist no-team model). They are REPLACED here with tests
// of the new Convex-backed behavior: the middleware resolves ownership via
// `checkOwnerEventTypeOwnership` (NOT_FOUND when `!found`, FORBIDDEN when not
// `owned`, proceed otherwise) and keeps the PURE in-memory `input.users` guard
// (every assigned user must be the owner themselves). `ensureEmailOrPhoneNumberIsPresent`
// is a pure function and its tests are UNCHANGED.
const checkOwnerEventTypeOwnership = vi.fn();
vi.mock("@calcom/lib/server/calcomAdminAdapters", () => ({
  checkOwnerEventTypeOwnership: (args: { ownerAuthUserId: string; calEventTypeId: number }) =>
    checkOwnerEventTypeOwnership(args),
}));

// Imported AFTER the mock is registered so util.ts picks up the mocked adapter.
const { createEventPbacProcedure, ensureEmailOrPhoneNumberIsPresent } = await import("../util");

describe("createEventPbacProcedure (CV-9 — Convex-backed ownership)", () => {
  // `uuid` is the dibslist authUserId the middleware now passes to Convex.
  const mockCtx = {
    user: { id: 1, uuid: "auth_user_me", profile: { upId: "user-1" } },
    session: { user: { id: 1 } },
  };

  const mockNext = vi.fn().mockResolvedValue({ ctx: mockCtx });

  // Helper to get the custom middleware (after authedProcedure)
  const getMiddleware = (procedure: ReturnType<typeof authedProcedure>) => {
    // The last middleware is our custom one
    return procedure._def.middlewares[procedure._def.middlewares.length - 1];
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("personal events (owner-scoped)", () => {
    it("should allow the owner to access their own event type", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: true });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();

      // The middleware resolved ownership via Convex, keyed by the owner's uuid + the
      // round-tripped cal int — never via ctx.prisma.
      expect(checkOwnerEventTypeOwnership).toHaveBeenCalledWith({
        ownerAuthUserId: "auth_user_me",
        calEventTypeId: 1,
      });
    });

    it("should deny (FORBIDDEN) a non-owner from accessing the event type", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: false });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 1 },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Permission required: eventType.update");
    });

    it("should only allow assigning self to a personal event", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: true });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1, users: [1] },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should deny assigning OTHER users to a personal event", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: true });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 1, users: [1, 2] },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toThrow("Cannot assign event to users outside of team membership");
    });

    it("should allow an empty users array", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: true });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1, users: [] },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });

    it("should not validate users when not provided", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: true });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { id: 1 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();
    });
  });

  describe("event not found", () => {
    it("should throw NOT_FOUND when the cal int maps to no event type", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: false, owned: false });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      const result = middleware({
        ctx: mockCtx,
        input: { id: 999 },
        next: mockNext,
        path: "test",
        type: "mutation",
        getRawInput: async () => ({}),
        meta: undefined,
      });

      await expect(result).rejects.toThrow(TRPCError);
      await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("input validation", () => {
    it("should accept eventTypeId as an alternative to id", async () => {
      checkOwnerEventTypeOwnership.mockResolvedValue({ found: true, owned: true });

      const procedure = createEventPbacProcedure("eventType.update");
      const middleware = getMiddleware(procedure);

      await expect(
        middleware({
          ctx: mockCtx,
          input: { eventTypeId: 7 },
          next: mockNext,
          path: "test",
          type: "mutation",
          getRawInput: async () => ({}),
          meta: undefined,
        })
      ).resolves.not.toThrow();

      expect(checkOwnerEventTypeOwnership).toHaveBeenCalledWith({
        ownerAuthUserId: "auth_user_me",
        calEventTypeId: 7,
      });
    });
  });

  describe("ensureEmailOrPhoneNumberIsPresent", () => {
    it("should throw error when both email and phone are hidden", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: true,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: true,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_email_and_phone_both_hidden",
        })
      );
    });

    it("should throw error when neither email nor phone is required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: false,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: false,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_email_or_phone_required",
        })
      );
    });

    it("should throw error when email is hidden and phone is not required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: true,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: false,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_phone_required_when_email_hidden",
        })
      );
    });

    it("should throw error when phone is hidden and email is not required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: false,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: true,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(TRPCError);
      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).toThrow(
        expect.objectContaining({
          code: "BAD_REQUEST",
          message: "booking_fields_email_required_when_phone_hidden",
        })
      );
    });

    it("should pass when email is visible and required while phone is hidden", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: false,
          hidden: true,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).not.toThrow();
    });

    it("should pass when phone is visible and required while email is hidden", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: false,
          hidden: true,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).not.toThrow();
    });

    it("should pass when both email and phone are visible and required", () => {
      const fields = [
        {
          name: "email",
          type: "email" as const,
          required: true,
          hidden: false,
        },
        {
          name: "attendeePhoneNumber",
          type: "phone" as const,
          required: true,
          hidden: false,
        },
      ];

      expect(() => ensureEmailOrPhoneNumberIsPresent(fields)).not.toThrow();
    });
  });
});

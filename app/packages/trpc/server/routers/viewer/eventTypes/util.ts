import type { EventTypeRepository } from "@calcom/features/eventtypes/repositories/eventTypeRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import { checkOwnerEventTypeOwnership } from "@calcom/lib/server/calcomAdminAdapters";
import prisma from "@calcom/prisma";
import type { MembershipRole } from "@calcom/prisma/enums";
import { PeriodType } from "@calcom/prisma/enums";
import type { CustomInputSchema } from "@calcom/prisma/zod-utils";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import authedProcedure from "../../../procedures/authedProcedure";
import type { TUpdateInputSchema } from "./types";

type PermissionString = string;
class PermissionCheckService {
  constructor(_prisma?: unknown) {}
  async checkPermission(..._args: unknown[]) { return true; }
  async hasPermission(..._args: unknown[]) { return true; }
  async getTeamIdsWithPermission(..._args: unknown[]): Promise<number[]> { return []; }
}

type EventType = Awaited<ReturnType<EventTypeRepository["findAllByUpId"]>>[number];

export const eventOwnerProcedure = authedProcedure
  .input(
    z
      .object({
        id: z.number().optional(),
        eventTypeId: z.number().optional(),
        users: z.array(z.number()).optional().default([]),
      })
      .refine((data) => data.id !== undefined || data.eventTypeId !== undefined, {
        message: "At least one of 'id' or 'eventTypeId' must be present",
        path: ["id", "eventTypeId"],
      })
  )
  .use(async ({ ctx, input, next }) => {
    const id = input.eventTypeId ?? input.id;
    // Prevent non-owners to update/delete a team event
    const event = await ctx.prisma.eventType.findUnique({
      where: { id },
      include: {
        users: {
          select: {
            id: true,
          },
        },
        team: {
          select: {
            members: {
              select: {
                userId: true,
                role: true,
              },
            },
          },
        },
      },
    });

    if (!event) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }

    const isAuthorized = (() => {
      if (event.team) {
        const teamMember = event.team.members.find((member) => member.userId === ctx.user.id);
        const isOwnerOrAdmin = teamMember?.role === "ADMIN" || teamMember?.role === "OWNER";

        return isOwnerOrAdmin;
      }
      return event.userId === ctx.user.id || event.users.find((user) => user.id === ctx.user.id);
    })();

    if (!isAuthorized) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const isAllowed = (() => {
      if (event.team) {
        const allTeamMembers = event.team.members.map((member) => member.userId);
        return input.users.every((userId: number) => allTeamMembers.includes(userId));
      }
      return input.users.every((userId: number) => userId === ctx.user.id);
    })();

    if (!isAllowed) {
      console.warn(
        `User ${ctx.user.id} attempted to an create an event for users ${input.users.join(", ")}.`
      );
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    return next();
  });

/**
 * Creates an event admin procedure with configurable permissions
 * @param permission - The specific permission required (e.g., "eventType.manage", "eventType.update")
 * @param fallbackRoles - Roles to check when PBAC is disabled (defaults to ["ADMIN", "OWNER"])
 * @returns A procedure that checks the specified permission
 */
export const createEventPbacProcedure = (
  permission: PermissionString,
  fallbackRoles: MembershipRole[] = ["ADMIN", "OWNER"]
) => {
  return authedProcedure
    .input(
      z
        .object({
          id: z.number().optional(),
          eventTypeId: z.number().optional(),
          users: z.array(z.number()).optional(),
        })
        .refine((data) => data.id !== undefined || data.eventTypeId !== undefined, {
          message: "At least one of 'id' or 'eventTypeId' must be present",
          path: ["id", "eventTypeId"],
        })
    )
    .use(async ({ ctx, input, next }) => {
      const id = input.eventTypeId ?? input.id;

      // CV-9 — THE CHOKEPOINT FIX. The original middleware ran an UNCONDITIONAL
      // `ctx.prisma.eventType.findUnique` here, then did an ownership check. On the
      // no-Postgres fork that findUnique THROWS — 500ing the entire event-type
      // editor lifecycle (get/update/delete/duplicate + the host sub-queries)
      // BEFORE the already-Convex-rewired handler bodies run. We replace it with an
      // owner-scoped Convex lookup keyed by the SAME cal int the editor round-trips
      // (via the CV-2c eventType id-map). NO `ctx.prisma` is touched.
      //
      // SEMANTICS PRESERVED (personal-owner / no-team model — dibslist has no team
      // or PBAC concept, so the dead team/PermissionCheckService branch is dropped):
      //   - the cal int maps to nothing            → NOT_FOUND (was `if (!event)`)
      //   - it maps to a row owned by someone else  → FORBIDDEN (was the personal
      //     `event.userId !== ctx.user.id` branch — an owner-scoped Convex row is
      //     the owner's by construction, so owner-match ≡ cal's `userId` match)
      //   - the caller owns it                       → proceed
      // The `input.users` assignment guard stays a PURE in-memory check (no DB):
      // every assigned user must be the owner themselves (cal's personal branch).
      const ownership = await checkOwnerEventTypeOwnership({
        ownerAuthUserId: ctx.user.uuid,
        calEventTypeId: id as number,
      });

      if (!ownership.found) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      if (!ownership.owned) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Permission required: ${permission}`,
        });
      }

      // Validate that assigned users are allowed — personal events may only assign
      // the owner themselves (no team membership exists to widen this).
      if (input.users && input.users.length > 0) {
        const isAllowed = input.users.every((userId: number) => userId === ctx.user.id);

        if (!isAllowed) {
          console.warn(
            `User ${ctx.user.id} attempted to assign event ${id} to users ${input.users.join(", ")}.`
          );
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cannot assign event to users outside of team membership",
          });
        }
      }

      return next();
    });
};

export function isPeriodType(keyInput: string): keyInput is PeriodType {
  return Object.keys(PeriodType).includes(keyInput);
}

export function handlePeriodType(periodType: string | undefined): PeriodType | undefined {
  if (typeof periodType !== "string") return undefined;
  const passedPeriodType = periodType.toUpperCase();
  if (!isPeriodType(passedPeriodType)) return undefined;
  return PeriodType[passedPeriodType];
}

export function handleCustomInputs(customInputs: CustomInputSchema[], eventTypeId: number) {
  const cInputsIdsToDeleteOrUpdated = customInputs.filter((input) => !input.hasToBeCreated);
  const cInputsIdsToDelete = cInputsIdsToDeleteOrUpdated.map((e) => e.id);
  const cInputsToCreate = customInputs
    .filter((input) => input.hasToBeCreated)
    .map((input) => ({
      type: input.type,
      label: input.label,
      required: input.required,
      placeholder: input.placeholder,
      options: input.options || undefined,
    }));
  const cInputsToUpdate = cInputsIdsToDeleteOrUpdated.map((input) => ({
    data: {
      type: input.type,
      label: input.label,
      required: input.required,
      placeholder: input.placeholder,
      options: input.options || undefined,
    },
    where: {
      id: input.id,
    },
  }));

  return {
    deleteMany: {
      eventTypeId,
      NOT: {
        id: { in: cInputsIdsToDelete },
      },
    },
    createMany: {
      data: cInputsToCreate,
    },
    update: cInputsToUpdate,
  };
}

export function ensureUniqueBookingFields(fields: TUpdateInputSchema["bookingFields"]) {
  if (!fields) {
    return;
  }

  fields.reduce(
    (discoveredFields, field) => {
      if (discoveredFields[field.name]) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Duplicate booking field name: ${field.name}`,
        });
      }

      discoveredFields[field.name] = true;

      return discoveredFields;
    },
    {} as Record<string, true>
  );
}

export function ensureEmailOrPhoneNumberIsPresent(fields: TUpdateInputSchema["bookingFields"]) {
  if (!fields || fields.length === 0) {
    return;
  }

  const attendeePhoneNumberField = fields.find((field) => field.name === "attendeePhoneNumber");

  const emailField = fields.find((field) => field.name === "email");

  if (emailField?.hidden && attendeePhoneNumberField?.hidden) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "booking_fields_email_and_phone_both_hidden",
    });
  }
  if (!emailField?.required && !attendeePhoneNumberField?.required) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "booking_fields_email_or_phone_required",
    });
  }
  if (emailField?.hidden && !attendeePhoneNumberField?.required) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "booking_fields_phone_required_when_email_hidden",
    });
  }
  if (attendeePhoneNumberField?.hidden && !emailField?.required) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "booking_fields_email_required_when_phone_hidden",
    });
  }
}

export const mapEventType = async (eventType: EventType) => ({
  ...eventType,
  safeDescription: eventType?.description ? markdownToSafeHTML(eventType.description) : undefined,
  users: await Promise.all(
    (eventType?.hosts?.length ? eventType.hosts.map((host) => host.user) : eventType.users).map(async (u) =>
      new UserRepository(prisma).enrichUserWithItsProfile({
        user: u,
      })
    )
  ),
  metadata: eventType.metadata ? EventTypeMetaDataSchema.parse(eventType.metadata) : null,
  children: await Promise.all(
    (eventType.children || []).map(async (c) => ({
      ...c,
      users: await Promise.all(
        c.users.map(
          async (u) =>
            await new UserRepository(prisma).enrichUserWithItsProfile({
              user: u,
            })
        )
      ),
    }))
  ),
});

// CV-2c — sourced from Convex via the int↔string event-type id map. `input.id`
// is the round-tripped cal int; the Convex adminDeleteEventType resolves it to
// the Convex `_id` and soft-deletes (active:false) — our backend has no hard
// delete, and the cal editor's "delete" just removes the event type from the list.
import { deleteOwnerEventTypeByCalId } from "@calcom/lib/server/calcomAdminAdapters";

import type { TrpcSessionUser } from "../../../types";
import type { TDeleteInputSchema } from "./delete.schema";

type DeleteOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TDeleteInputSchema;
};

export const deleteHandler = async ({ ctx, input }: DeleteOptions) => {
  const { id } = input;

  await deleteOwnerEventTypeByCalId({
    ownerAuthUserId: ctx.user.uuid,
    calEventTypeId: id,
  });

  // cal echoes the int id back to the client (used for cache invalidation).
  return {
    id,
  };
};

import { listOwnerEventTypeRows } from "@calcom/lib/server/calcomAdminAdapters";
import db from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";

import type { TrpcSessionUser } from "../../../types";

type ListWithTeamOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id" | "uuid" | "username">;
  };
};

export const listWithTeamHandler = async ({ ctx }: ListWithTeamOptions) => {
  const userId = ctx.user.id;

  // CV — no-Postgres fork: the raw `$queryRaw` below targets Postgres directly and
  // THROWS (no DB), 500ing the event-types page picker (it fires on the dashboard).
  // The dibslist fork has no cal teams, so return the owner's OWN event types from
  // Convex with `team: null`. The `uuid` (dibslist authUserId) is the fork signal;
  // the Postgres path is LEFT INTACT for the uuid-absent case (a real Postgres deploy).
  if (ctx.user.uuid) {
    const rows = await listOwnerEventTypeRows({ ownerAuthUserId: ctx.user.uuid });
    return rows.map((row) => ({
      id: row.calId ?? 0,
      team: null as { id: number; name: string } | null,
      title: row.title,
      slug: row.slug,
      length: row.durationMinutes,
      username: ctx.user.username ?? null,
    }));
  }

  const query = Prisma.sql`SELECT "public"."EventType"."id", "public"."EventType"."teamId", "public"."EventType"."title", "public"."EventType"."slug", "public"."EventType"."length", "j1"."name" as "teamName", "u"."username" as "username"
    FROM "public"."EventType"
    LEFT JOIN "public"."Team" AS "j1" ON ("j1"."id") = ("public"."EventType"."teamId")
    LEFT JOIN "public"."users" AS "u" ON ("u"."id") = ("public"."EventType"."userId")
    WHERE "public"."EventType"."userId" = ${userId}
    UNION
    SELECT "public"."EventType"."id", "public"."EventType"."teamId", "public"."EventType"."title", "public"."EventType"."slug", "public"."EventType"."length", "j1"."name" as "teamName", "u"."username" as "username"
    FROM "public"."EventType"
    INNER JOIN "public"."Team" AS "j1" ON ("j1"."id") = ("public"."EventType"."teamId")
    INNER JOIN "public"."Membership" AS "t2" ON "t2"."teamId" = "j1"."id"
    LEFT JOIN "public"."users" AS "u" ON ("u"."id") = ("public"."EventType"."userId")
    WHERE "t2"."userId" = ${userId} AND "t2"."accepted" = true`;

  const result =
    await db.$queryRaw<
      {
        id: number;
        teamId: number | null;
        title: string;
        slug: string;
        length: number;
        teamName: string | null;
        username: string | null;
      }[]
    >(query);

  return result.map((row) => ({
    id: row.id,
    team: row.teamId ? { id: row.teamId, name: row.teamName || "" } : null,
    title: row.title,
    slug: row.slug,
    length: row.length,
    username: row.teamId ? null : row.username,
  }));
};

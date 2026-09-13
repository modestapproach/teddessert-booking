import SettingsHeader from "@calcom/features/settings/appDir/SettingsHeader";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { prisma } from "@calcom/prisma";
import type { Params } from "app/_types";
import { _generateMetadata, getTranslate } from "app/_utils";
import { notFound } from "next/navigation";
import { z } from "zod";
import { UsersEditView } from "~/users/views/users-edit-view";

const userIdSchema = z.object({ id: z.coerce.number() });

// no-Postgres fork: this admin page reads prisma (UserRepository.adminFindById) →
// 500s. The cal admin tree is orphaned on the fork; 404 instead of crashing.
const IS_CONVEX_FORK = !!process.env.NEXT_PUBLIC_CONVEX_URL;

export const generateMetadata = async ({ params }: { params: Params }) => {
  if (IS_CONVEX_FORK) {
    return await _generateMetadata(
      (t) => t("editing_user"),
      (t) => t("admin_users_edit_description"),
      undefined,
      undefined,
      "/settings/admin/users/edit"
    );
  }
  const input = userIdSchema.safeParse(await params);
  if (!input.success) {
    return await _generateMetadata(
      (t) => t("editing_user"),
      (t) => t("admin_users_edit_description"),
      undefined,
      undefined,
      "/settings/admin/users/edit"
    );
  }

  const userRepo = new UserRepository(prisma);
  const user = await userRepo.adminFindById(input.data.id);

  return await _generateMetadata(
    (t) => `${t("editing_user")}: ${user.username}`,
    (t) => t("admin_users_edit_description"),
    undefined,
    undefined,
    `/settings/admin/users/${input.data.id}/edit`
  );
};

const Page = async ({ params }: { params: Params }) => {
  if (IS_CONVEX_FORK) {
    notFound();
  }
  const input = userIdSchema.safeParse(await params);

  if (!input.success) throw new Error("Invalid access");

  const userRepo = new UserRepository(prisma);
  const user = await userRepo.adminFindById(input.data.id);

  const t = await getTranslate();

  return (
    <SettingsHeader title={t("editing_user")} description={t("admin_users_edit_description")}>
      <UsersEditView user={user} />
    </SettingsHeader>
  );
};

export default Page;

import type { PageProps } from "app/_types";
import { redirect } from "next/navigation";
import { z } from "zod";

import { AppCategories } from "@calcom/prisma/enums";

import { getStaticProps } from "@lib/apps/categories/[category]/getStaticProps";

import CategoryPage from "~/apps/categories/[category]/category-view";

const querySchema = z.object({
  category: z.enum(Object.values(AppCategories) as [AppCategories, ...AppCategories[]]),
});

async function Page({ params, searchParams }: PageProps) {
  const parsed = querySchema.safeParse({ ...(await params), ...(await searchParams) });

  // no-Postgres fork: the cal App Store is Prisma- + app-registry-based, so
  // `getStaticProps` below THROWS → a Server Components 500. Several in-app links
  // still target `/apps/categories/*` ("Add calendar", install-app buttons in the
  // booker/troubleshooter, the conferencing locations link). Redirect them to the
  // working settings surfaces instead of crashing. The calendar "Add" buttons
  // themselves were repointed to the Convex Google-connect flow; this is the net.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    const category = parsed.success ? parsed.data.category : null;
    redirect(category === "conferencing" ? "/event-types" : "/settings/my-account/calendars");
  }

  if (!parsed.success) {
    redirect("/apps/categories/calendar");
  }

  const props = await getStaticProps(parsed.data.category);

  return <CategoryPage {...props} />;
}

export default Page;

import { withAppDirSsr } from "app/WithAppDirSsr";
import type { PageProps } from "app/_types";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getServerSideProps } from "@lib/apps/categories/getServerSideProps";
import { buildLegacyCtx } from "@lib/buildLegacyCtx";

import Page from "~/apps/categories/categories-view";

const getData = withAppDirSsr(getServerSideProps);

async function ServerPage({ params, searchParams }: PageProps) {
  // no-Postgres fork: cal's App Store is Prisma/app-registry-based → getServerSideProps
  // 500s here. Redirect to the working home instead of crashing.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    redirect("/event-types");
  }
  const props = await getData(
    buildLegacyCtx(await headers(), await cookies(), await params, await searchParams)
  );

  return <Page {...props} />;
}

export default ServerPage;

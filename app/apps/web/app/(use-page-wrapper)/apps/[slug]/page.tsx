import type { PageProps as _PageProps } from "app/_types";
import { generateAppMetadata } from "app/_utils";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { getStaticProps } from "@lib/apps/[slug]/getStaticProps";

import AppView from "~/apps/[slug]/slug-view";

const paramsSchema = z.object({
  slug: z.string(),
});

// no-Postgres fork: the App Store app-detail page reads prisma.app + the app
// registry → 500s. Skip metadata generation on the fork (the page redirects).
const IS_CONVEX_FORK = !!process.env.NEXT_PUBLIC_CONVEX_URL;

export const generateMetadata = async ({ params }: _PageProps) => {
  if (IS_CONVEX_FORK) {
    return {};
  }
  const p = paramsSchema.safeParse(await params);

  if (!p.success) {
    return notFound();
  }
  const slugFromUrl = p.data.slug;
  const props = await getStaticProps(slugFromUrl);

  if (!props) {
    notFound();
  }
  const { name, logo, dirName: appStoreDirSlug, slug: appSlug, description } = props.data;

  return await generateAppMetadata(
    { slug: appStoreDirSlug ?? appSlug, logoUrl: logo, name, description },
    () => name,
    () => description,
    undefined,
    undefined,
    `/apps/${appSlug}`
  );
};

async function Page({ params }: _PageProps) {
  // no-Postgres fork: redirect off the dead App Store instead of crashing in
  // getStaticProps (prisma.app + app registry).
  if (IS_CONVEX_FORK) {
    redirect("/event-types");
  }
  const p = paramsSchema.safeParse(await params);

  if (!p.success) {
    return notFound();
  }

  const props = await getStaticProps(p.data.slug);

  if (!props) {
    notFound();
  }

  return <AppView {...props} />;
}

export default Page;

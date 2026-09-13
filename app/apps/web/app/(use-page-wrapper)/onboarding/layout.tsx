import { redirect } from "next/navigation";

import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import { prisma } from "@calcom/prisma";

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // no-Postgres fork: checkIfFeatureIsEnabledGlobally → prisma.feature.findMany THROWS.
  // The fork uses the /getting-started onboarding (not this V3 tree), so redirect there
  // before touching prisma.
  if (process.env.NEXT_PUBLIC_CONVEX_URL) {
    redirect("/getting-started");
  }
  const featuresRepository = new FeaturesRepository(prisma);
  const isOnboardingV3Enabled = await featuresRepository.checkIfFeatureIsEnabledGlobally("onboarding-v3");

  if (!isOnboardingV3Enabled) {
    redirect("/getting-started");
  }

  return <>{children}</>;
}

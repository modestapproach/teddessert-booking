import type { FeatureId } from "@calcom/features/flags/config";
import type { FeatureDto } from "@calcom/lib/dto/FeatureDto";
import type { PrismaClient } from "@calcom/prisma/client";

export interface IFeatureRepository {
  findAll(): Promise<FeatureDto[]>;
  findBySlug(slug: string): Promise<FeatureDto | null>;
  update(input: { featureId: FeatureId; enabled: boolean; updatedBy?: number }): Promise<FeatureDto>;
  checkIfFeatureIsEnabledGlobally(slug: string): Promise<boolean>;
  getFeatureFlagMap(): Promise<Record<string, boolean>>;
}

export class PrismaFeatureRepository implements IFeatureRepository {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async findAll(): Promise<FeatureDto[]> {
    // CV — the no-Postgres fork has no Feature table; this Prisma read throws and
    // 500s `viewer.features.map` (queried on most pages → triggers a React #419
    // hydration error). Cal feature flags default OFF when absent, so return an
    // empty set on the fork. The Prisma path is intact for a real Postgres deploy.
    if (process.env.NEXT_PUBLIC_CONVEX_URL) return [];
    return this.prisma.feature.findMany({
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        enabled: true,
        description: true,
        type: true,
        stale: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
        updatedBy: true,
      },
    });
  }

  async findBySlug(slug: string): Promise<FeatureDto | null> {
    // CV — no-Postgres fork: no Feature table → no globally-set flag. Return null
    // (treated as disabled) instead of throwing. Prisma path intact for Postgres.
    if (process.env.NEXT_PUBLIC_CONVEX_URL) return null;
    return this.prisma.feature.findUnique({
      where: { slug },
      select: {
        slug: true,
        enabled: true,
        description: true,
        type: true,
        stale: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
        updatedBy: true,
      },
    });
  }

  async update(input: { featureId: FeatureId; enabled: boolean; updatedBy?: number }): Promise<FeatureDto> {
    const { featureId, enabled, updatedBy } = input;
    return this.prisma.feature.update({
      where: { slug: featureId },
      data: { enabled, updatedBy, updatedAt: new Date() },
      select: {
        slug: true,
        enabled: true,
        description: true,
        type: true,
        stale: true,
        lastUsedAt: true,
        createdAt: true,
        updatedAt: true,
        updatedBy: true,
      },
    });
  }

  async checkIfFeatureIsEnabledGlobally(slug: string): Promise<boolean> {
    const feature = await this.prisma.feature.findUnique({
      where: { slug },
      select: { enabled: true },
    });
    return Boolean(feature?.enabled);
  }

  async getFeatureFlagMap(): Promise<Record<string, boolean>> {
    const flags = await this.findAll();
    return flags.reduce(
      (acc, flag) => {
        acc[flag.slug as FeatureId] = flag.enabled;
        return acc;
      },
      {} as Record<string, boolean>
    );
  }
}

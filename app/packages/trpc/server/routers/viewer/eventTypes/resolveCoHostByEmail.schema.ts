import { z } from "zod";

// CV-7 — resolve a dibslist email into a co-host candidate for the event-type
// editor's "add co-host by email" picker. Minimal input: just the email.
export const ZResolveCoHostByEmailInputSchema = z.object({
  email: z.string().trim().min(1).max(320),
});

export type TResolveCoHostByEmailInputSchema = z.infer<typeof ZResolveCoHostByEmailInputSchema>;

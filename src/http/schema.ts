import { z } from "zod";

export const noteDraftSchema = z.object({
  type: z.literal("note"),
  content: z.string().trim().min(1),
  proposedFireAt: z.number().int().nonnegative(),
});

export const threadDraftSchema = z.object({
  type: z.literal("thread"),
  segments: z
    .array(
      z.object({
        content: z.string().trim().min(1),
        proposedFireAt: z.number().int().nonnegative(),
      }),
    )
    .min(2),
});

export const replyDraftSchema = z.object({
  type: z.literal("reply"),
  content: z.string().trim().min(1),
  proposedFireAt: z.number().int().nonnegative(),
  target: z.object({
    eventId: z.string().regex(/^[0-9a-f]{64}$/),
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    rootId: z.string().regex(/^[0-9a-f]{64}$/),
    relayHint: z.string().optional(),
  }),
  parent: z
    .object({
      at: z.number().int().nonnegative(),
      content: z.string().trim().min(1),
    })
    .optional(),
});

export const draftSchema = z.discriminatedUnion("type", [noteDraftSchema, threadDraftSchema, replyDraftSchema]);

export const rejectSchema = z.object({
  reason: z.string().trim().min(1),
});

export const editSchema = z.object({
  draft: draftSchema,
});

export const composeSchema = z.object({
  profileId: z.string().min(1),
  draft: draftSchema,
});

export const suggestionSchema = z.object({
  profileId: z.string().min(1),
  draft: draftSchema,
  rationale: z.string().default(""),
});

export const rescheduleSchema = z.object({
  fireAt: z.number().int().nonnegative(),
});

export const discardSchema = z.object({
  reason: z.string().trim().min(1),
});

export const contextSchema = z.object({
  profileId: z.string().min(1),
  ref: z.string().trim().min(1),
});

export const signNextSchema = z.object({
  profileId: z.string().min(1),
  itemIds: z.array(z.string()).optional(),
});

export const signSubmitSchema = z.object({
  itemId: z.string().min(1),
  event: z.unknown(),
});

export const bunkerSchema = z.object({
  profileId: z.string().min(1),
  bunkerUri: z.string().trim().min(1),
});

export const profileActionSchema = z.object({
  profileId: z.string().min(1),
});

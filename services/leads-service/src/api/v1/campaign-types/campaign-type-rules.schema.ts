import { z } from 'zod';

// marketing.campaign_type_rules (1.51.0): the ORDERED list that turns Meta names
// into a campaign type. First match wins, in rule_order. A pattern matches on
// WORD BOUNDARIES, case-insensitive (marketing.fn_match_campaign_type_rules), so
// it is trimmed here and kept short enough that it reads as a phrase, not a
// sentence.

export const ruleMatchFieldSchema = z.enum(['campaign_name', 'form_name', 'adset_name', 'ad_name']);

const pattern = z.string().trim().min(2).max(100);

export const createRuleBodySchema = z.object({
  match_field: ruleMatchFieldSchema,
  pattern,
  campaign_type_id: z.string().uuid(),
  // Omitted = appended after the last rule (lowest precedence).
  rule_order: z.number().int().min(1).max(1_000_000).optional(),
});

export const updateRuleBodySchema = z
  .object({
    match_field: ruleMatchFieldSchema.optional(),
    pattern: pattern.optional(),
    campaign_type_id: z.string().uuid().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

// The WHOLE live list, in the new order. Partial reorders are refused: a list
// the client has only half-loaded must not silently renumber the other half.
export const reorderRulesBodySchema = z.object({
  rule_ids: z.array(z.string().uuid()).min(1).max(500),
});

// "Which rule would this hit?" — the Campaign Types screen's test box.
export const testRulesBodySchema = z.object({
  campaign_name: z.string().max(500).optional(),
  form_name: z.string().max(500).optional(),
  adset_name: z.string().max(500).optional(),
  ad_name: z.string().max(500).optional(),
});

export type CreateRuleBody = z.infer<typeof createRuleBodySchema>;
export type UpdateRuleBody = z.infer<typeof updateRuleBodySchema>;
export type ReorderRulesBody = z.infer<typeof reorderRulesBodySchema>;
export type TestRulesBody = z.infer<typeof testRulesBodySchema>;

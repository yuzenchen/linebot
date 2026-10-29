import { z } from 'zod';

export const categories = [
  'kb_answer',
  'service_related',
  'incident_report',
  'feature_request',
  'off_topic',
] as const;

export type Category = (typeof categories)[number];

export const classificationSchema = z.object({
  category: z.enum(categories),
  confidence: z.number().min(0).max(1),
  answer: z.string().nullable(),
  reason: z.string(),
});

export type Classification = z.infer<typeof classificationSchema>;

export type ContextMessage = { role: 'user' | 'assistant'; text: string };

export type ClassifyInput = { text: string; context: ContextMessage[] };

export type ClassifyResult = Classification & {
  classifier: 'anthropic' | 'rule';
  latencyMs: number;
};

export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyResult>;
}

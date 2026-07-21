import { z } from 'zod';

export const generatedFileSchema = z.object({
  path: z.string(),
  content: z.string()
});

export const designBriefSchema = z.object({
  pageType: z.string(),
  brandName: z.string(),
  audience: z.string(),
  mood: z.string(),
  colorPalette: z.array(z.string()),
  typography: z.string(),
  sections: z.array(z.string()),
  primaryCta: z.string(),
  acceptanceCriteria: z.array(z.string()),
  implementationPlan: z.array(z.string()),
  riskLevel: z.enum(['low', 'medium', 'high'])
});

export const figmaDesignArtifactSchema = z.object({
  fileName: z.string(),
  frameName: z.string(),
  figmaUrl: z.string().nullable(),
  pluginPayloadPath: z.string(),
  designSpecPath: z.string(),
  nodes: z.array(z.object({
    name: z.string(),
    type: z.enum(['frame', 'section', 'text', 'button', 'card']),
    description: z.string()
  }))
});

export const reactGenerationResultSchema = z.object({
  summary: z.string(),
  componentName: z.string(),
  previewHtml: z.string(),
  generatedFiles: z.array(generatedFileSchema)
});

export const uiQualityReviewSchema = z.object({
  uiQualityScore: z.number().min(0).max(100),
  codeQualityScore: z.number().min(0).max(100),
  requirementCoverageScore: z.number().min(0).max(100),
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  findings: z.array(z.string()),
  codeFindings: z.array(z.string()),
  requirementFindings: z.array(z.string()),
  blockingIssues: z.array(z.string()),
  regenerationPrompt: z.string()
});

export const deliveryRecordSchema = z.object({
  id: z.string(),
  request: z.string(),
  requester: z.string(),
  workstream: z.string(),
  status: z.string(),
  lastUpdatedAt: z.string(),
  figmaUrl: z.string().nullable().optional(),
  figmaDesignSpecPath: z.string().nullable().optional(),
  figmaPluginPayloadPath: z.string().nullable().optional(),
  designBrief: z.lazy(() => designBriefSchema).optional(),
  llmSummary: z.string().nullable().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  implementationPlan: z.array(z.string()).optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  generatedPreviewHtml: z.string().optional(),
  generatedFiles: z.array(z.string()).optional(),
  uiQualityScore: z.number().optional(),
  uiQualityFindings: z.array(z.string()).optional()
});

export const deliveryDatabaseSchema = z.object({
  organization: z.string().optional(),
  lastUpdated: z.string().optional(),
  requests: z.array(deliveryRecordSchema)
});

export const executionContextSchema = z.object({
  requester: z.string().min(1),
  requestedWork: z.string().min(1),
  branchName: z.string().nullable().optional(),
  prOwner: z.string().nullable().optional(),
  prRepo: z.string().nullable().optional(),
  ticketId: z.string().nullable().optional(),
  ticketUrl: z.string().nullable().optional(),
  governanceNotes: z.array(z.string()).optional()
});

export const designBriefResultsSchema = executionContextSchema.extend({
  designBrief: designBriefSchema
});

export const figmaDesignResultsSchema = designBriefResultsSchema.extend({
  figmaDesign: figmaDesignArtifactSchema
});

export const reactGenerationResultsSchema = figmaDesignResultsSchema.extend({
  reactGeneration: reactGenerationResultSchema,
  uiQualityReview: uiQualityReviewSchema.optional()
});

export const analysisResultsSchema = reactGenerationResultsSchema.extend({
  previousOwner: z.string(),
  requestId: z.string(),
  analysisStatus: z.enum(['updated_existing', 'new_request']),
  updatedRequestArray: z.array(deliveryRecordSchema),
  database: deliveryDatabaseSchema
});

export const mutationResultsSchema = analysisResultsSchema.extend({
  databasePath: z.string(),
  recordsUpdated: z.number()
});

export const governanceResultsSchema = mutationResultsSchema.extend({
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prOwner: z.string().nullable(),
  prRepo: z.string().nullable(),
  branchName: z.string().nullable(),
  ticketId: z.string().nullable(),
  ticketUrl: z.string().nullable(),
  generatedUiUrl: z.string(),
  governanceStatus: z.enum(['created', 'skipped', 'partial']),
  governanceNotes: z.array(z.string()),
  releaseReady: z.boolean()
});

export const workflowResultsSchema = z.object({
  status: z.literal('success'),
  requester: z.string(),
  requestedWork: z.string(),
  designBrief: designBriefSchema,
  figmaDesign: figmaDesignArtifactSchema,
  reactGeneration: reactGenerationResultSchema,
  previousOwner: z.string(),
  requestId: z.string(),
  analysisStatus: z.enum(['updated_existing', 'new_request']),
  databasePath: z.string(),
  recordsUpdated: z.number(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  prOwner: z.string().nullable(),
  prRepo: z.string().nullable(),
  ticketId: z.string().nullable(),
  ticketUrl: z.string().nullable(),
  generatedUiUrl: z.string(),
  governanceStatus: z.enum(['created', 'skipped', 'partial']),
  governanceNotes: z.array(z.string()),
  releaseReady: z.boolean(),
  slackDispatched: z.boolean()
});

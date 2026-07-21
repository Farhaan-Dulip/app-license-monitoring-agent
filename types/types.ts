import type { Request } from 'express';

export type GeneratedFile = {
  path: string;
  content: string;
};

export type DesignBrief = {
  pageType: string;
  brandName: string;
  audience: string;
  mood: string;
  colorPalette: string[];
  typography: string;
  sections: string[];
  primaryCta: string;
  acceptanceCriteria: string[];
  implementationPlan: string[];
  riskLevel: 'low' | 'medium' | 'high';
};

export type FigmaDesignArtifact = {
  fileName: string;
  frameName: string;
  figmaUrl: string | null;
  pluginPayloadPath: string;
  designSpecPath: string;
  nodes: Array<{
    name: string;
    type: 'frame' | 'section' | 'text' | 'button' | 'card';
    description: string;
  }>;
};

export type ReactGenerationResult = {
  summary: string;
  componentName: string;
  previewHtml: string;
  generatedFiles: GeneratedFile[];
};

export type UiQualityReview = {
  uiQualityScore: number;
  codeQualityScore: number;
  requirementCoverageScore: number;
  score: number;
  passed: boolean;
  findings: string[];
  codeFindings: string[];
  requirementFindings: string[];
  blockingIssues: string[];
  regenerationPrompt: string;
};

export type DeliveryRecord = {
  id: string;
  request: string;
  requester: string;
  workstream: string;
  status: string;
  lastUpdatedAt: string;
  figmaUrl?: string | null | undefined;
  figmaDesignSpecPath?: string | null | undefined;
  figmaPluginPayloadPath?: string | null | undefined;
  designBrief?: DesignBrief | undefined;
  llmSummary?: string | null | undefined;
  acceptanceCriteria?: string[] | undefined;
  implementationPlan?: string[] | undefined;
  riskLevel?: 'low' | 'medium' | 'high' | undefined;
  generatedPreviewHtml?: string | undefined;
  generatedFiles?: string[] | undefined;
  uiQualityScore?: number | undefined;
  uiQualityFindings?: string[] | undefined;
};

export type DeliveryDatabase = {
  organization?: string | undefined;
  lastUpdated?: string | undefined;
  requests: DeliveryRecord[];
};

export type ExecutionContext = {
  requester: string;
  requestedWork: string;
  branchName?: string | null | undefined;
  prOwner?: string | null | undefined;
  prRepo?: string | null | undefined;
  ticketId?: string | null | undefined;
  ticketUrl?: string | null | undefined;
  governanceNotes?: string[] | undefined;
};

export type DesignBriefResults = ExecutionContext & {
  designBrief: DesignBrief;
};

export type FigmaDesignResults = DesignBriefResults & {
  figmaDesign: FigmaDesignArtifact;
};

export type ReactGenerationResults = FigmaDesignResults & {
  reactGeneration: ReactGenerationResult;
  uiQualityReview?: UiQualityReview | undefined;
};

export type AnalysisResults = ReactGenerationResults & {
  previousOwner: string;
  requestId: string;
  analysisStatus: 'updated_existing' | 'new_request';
  updatedRequestArray: DeliveryRecord[];
  database: DeliveryDatabase;
};

export type MutationResults = AnalysisResults & {
  databasePath: string;
  recordsUpdated: number;
};

export type GovernanceResults = MutationResults & {
  prUrl: string | null;
  prNumber: number | null;
  prOwner: string | null;
  prRepo: string | null;
  branchName: string | null;
  ticketId: string | null;
  ticketUrl: string | null;
  generatedUiUrl: string;
  governanceStatus: 'created' | 'skipped' | 'partial';
  governanceNotes: string[];
  releaseReady: boolean;
};

export type WorkflowResults = {
  status: 'success';
  requester: string;
  requestedWork: string;
  designBrief: DesignBrief;
  figmaDesign: FigmaDesignArtifact;
  reactGeneration: ReactGenerationResult;
  previousOwner: string;
  requestId: string;
  analysisStatus: 'updated_existing' | 'new_request';
  databasePath: string;
  recordsUpdated: number;
  prUrl: string | null;
  prNumber: number | null;
  prOwner: string | null;
  prRepo: string | null;
  ticketId: string | null;
  ticketUrl: string | null;
  generatedUiUrl: string;
  governanceStatus: 'created' | 'skipped' | 'partial';
  governanceNotes: string[];
  releaseReady: boolean;
  slackDispatched: boolean;
};

export type RequestWithRawBody = Request & {
  rawBody?: string;
};

export type McpTextContent = {
  type: 'text';
  text: string;
};

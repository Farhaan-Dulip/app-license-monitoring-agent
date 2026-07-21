import express, {} from 'express';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import dotenv from 'dotenv';
import { z } from 'zod';
import { analysisResultsSchema, designBriefResultsSchema, designBriefSchema, executionContextSchema, figmaDesignResultsSchema, governanceResultsSchema, mutationResultsSchema, reactGenerationResultsSchema, workflowResultsSchema } from './schemas/schemas.js';
import { buildGeneratedUiUrl, daysSince, getErrorMessage, optionalEnv } from './services/runtime/runtime.js';
import { extractChatCompletionText, valueToText, valueToTextArray } from './agent-utils/agentUtils.js';
import { createFigmaDesignFromBrief } from './agents/figma-design-agent/figmaDesignAgent.js';
import { generateReactFromFigmaDesign } from './agents/code-generation-agent/codeGenerationAgent.js';
import { reviewReactUiQuality } from './agents/ui-review-agent/uiReviewAgent.js';
import { triggerRailwayDeployment, waitForRailwayGeneratedUi } from './services/railway/railway.js';
import { readDeliveryDatabaseViaMcp, writeDeliveryDatabaseViaMcp, writeGeneratedArtifactViaMcp } from './services/mcp/deliveryMcp.js';
import { closeLinearTicketAfterMerge, createGitHubEvidenceBranch, ensureEvidencePullRequest, mergeGitHubPrAfterReview, postGitHubPrReviewComment, provisionGovernanceIntake, syncEvidenceToGitHubBranch } from './services/governance/governanceIntegrations.js';
import { dispatchSlackInteractiveCard, parseSlackCommandText } from './services/slack/slack.js';
import { buildFigmaPluginSessionPayload, renderGeneratedUi } from './views/deliveryViews.js';
dotenv.config();
// Calls OpenAI in JSON mode and validates the returned object with the provided Zod schema.
async function callOpenAiJson(prompt, schema, fallback) {
    const apiKey = optionalEnv('OPENAI_API_KEY');
    if (!apiKey) {
        console.warn('OPENAI_API_KEY is not configured; using deterministic local LLM fallback.');
        return fallback;
    }
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: optionalEnv('OPENAI_MODEL') ?? 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: 'You are an AI product designer and frontend architect. Always return valid JSON only.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ]
        })
    });
    if (!response.ok) {
        console.error('OpenAI LLM request failed:', await response.text());
        return fallback;
    }
    return schema.parse(JSON.parse(extractChatCompletionText(await response.json())));
}
// Produces a reliable local design brief when the LLM is unavailable.
function fallbackDesignBrief(requestedWork) {
    const normalizedWork = requestedWork.trim() || 'a modern product experience';
    return {
        pageType: 'product marketing page',
        brandName: 'Northstar Studio',
        audience: 'prospective users evaluating whether the experience solves their problem',
        mood: 'confident, modern, high-trust, and approachable',
        colorPalette: ['#0f172a', '#f8fafc', '#0ea5e9', '#14b8a6', '#f97316'],
        typography: 'Expressive display heading paired with a clean sans-serif body',
        sections: ['Navigation', 'Hero value proposition', 'Feature highlights', 'Use-case or workflow section', 'Primary conversion CTA', 'Footer'],
        primaryCta: 'Get Started',
        acceptanceCriteria: [
            'Responsive UI renders correctly on mobile and desktop',
            'Hero section communicates clear value and includes a primary CTA',
            'Core sections map to the request intent and maintain strong visual hierarchy',
            'Final page includes GitHub, Linear, Railway, and Figma traceability'
        ],
        implementationPlan: [
            `Create a Figma-ready frame specification aligned to: ${normalizedWork}`,
            'Generate React component structure from the design spec',
            'Write CSS for responsive layout, palette, spacing, and cards',
            'Commit generated artifacts and delivery metadata through GitHub governance'
        ],
        riskLevel: 'low'
    };
}
// Normalizes model variants like "Medium" into the strict risk enum.
function normalizeRiskLevel(value) {
    const normalized = valueToText(value, 'low').toLowerCase();
    if (normalized.includes('high')) {
        return 'high';
    }
    if (normalized.includes('medium')) {
        return 'medium';
    }
    return 'low';
}
// Repairs common LLM shape drift while preserving the model's semantic choices.
function normalizeDesignBrief(rawBrief, requestedWork) {
    const fallback = fallbackDesignBrief(requestedWork);
    const rawRecord = rawBrief && typeof rawBrief === 'object' ? rawBrief : {};
    const normalizedBrief = {
        pageType: valueToText(rawRecord.pageType, fallback.pageType),
        brandName: valueToText(rawRecord.brandName, fallback.brandName),
        audience: valueToText(rawRecord.audience, fallback.audience),
        mood: valueToText(rawRecord.mood, fallback.mood),
        colorPalette: valueToTextArray(rawRecord.colorPalette, fallback.colorPalette).slice(0, 8),
        typography: valueToText(rawRecord.typography, fallback.typography),
        sections: valueToTextArray(rawRecord.sections, fallback.sections),
        primaryCta: valueToText(rawRecord.primaryCta, fallback.primaryCta),
        acceptanceCriteria: valueToTextArray(rawRecord.acceptanceCriteria, fallback.acceptanceCriteria),
        implementationPlan: valueToTextArray(rawRecord.implementationPlan, fallback.implementationPlan),
        riskLevel: normalizeRiskLevel(rawRecord.riskLevel)
    };
    return designBriefSchema.parse(normalizedBrief);
}
// Uses an LLM to convert the Slack prompt into a structured product/design brief.
async function generateDesignBriefWithLlm(context) {
    const prompt = [
        'Return JSON for a design brief that matches the Slack prompt domain and intent.',
        `Slack requester: ${context.requester}`,
        `Slack prompt: ${context.requestedWork}`,
        'The user wants the Figma agent to create the design first, then convert that design to React.',
        'Required JSON keys: pageType, brandName, audience, mood, colorPalette, typography, sections, primaryCta, acceptanceCriteria, implementationPlan, riskLevel.',
        'Important: colorPalette must be an array of hex color strings.',
        'Important: typography, primaryCta, and every sections item must be plain strings.',
        'Important: riskLevel must be exactly one of: low, medium, high.',
        'Use realistic, domain-appropriate content inferred from the prompt.',
        'Do not force a specific industry, theme, or vertical when the prompt asks for something else.',
        'When the prompt is vague, choose a plausible default domain and keep the brief internally consistent.'
    ].join('\n');
    const rawBrief = await callOpenAiJson(prompt, z.unknown(), fallbackDesignBrief(context.requestedWork));
    return {
        ...context,
        designBrief: normalizeDesignBrief(rawBrief, context.requestedWork)
    };
}
// ---------------------------------------------------------
// NODE 2: AI Delivery Request Analysis Logic
// ---------------------------------------------------------
// Analyzes the incoming engineering request, updates matching draft work, or creates a new delivery record.
async function runDeliveryAnalysis(generationContext) {
    const database = await readDeliveryDatabaseViaMcp();
    const matchingRequests = database.requests.filter((record) => record.request.toLowerCase() === generationContext.requestedWork.toLowerCase());
    const existingRequesterRecord = matchingRequests.find((record) => record.requester.toLowerCase() === generationContext.requester.toLowerCase());
    if (existingRequesterRecord) {
        const refreshedRequestArray = database.requests.map((record) => record.id === existingRequesterRecord.id
            ? {
                ...record,
                request: generationContext.requestedWork,
                requester: generationContext.requester,
                status: 'proposed',
                lastUpdatedAt: new Date().toISOString().slice(0, 10),
                figmaUrl: generationContext.figmaDesign.figmaUrl,
                figmaDesignSpecPath: generationContext.figmaDesign.designSpecPath,
                figmaPluginPayloadPath: generationContext.figmaDesign.pluginPayloadPath,
                designBrief: generationContext.designBrief,
                llmSummary: generationContext.reactGeneration.summary,
                acceptanceCriteria: generationContext.designBrief.acceptanceCriteria,
                implementationPlan: generationContext.designBrief.implementationPlan,
                riskLevel: generationContext.designBrief.riskLevel,
                generatedPreviewHtml: generationContext.reactGeneration.previewHtml,
                generatedFiles: generationContext.reactGeneration.generatedFiles.map((file) => file.path),
                uiQualityScore: generationContext.uiQualityReview?.score,
                uiQualityFindings: generationContext.uiQualityReview?.findings
            }
            : record);
        return {
            ...generationContext,
            previousOwner: existingRequesterRecord.requester,
            requestId: existingRequesterRecord.id,
            analysisStatus: 'updated_existing',
            updatedRequestArray: refreshedRequestArray,
            database: {
                ...database,
                lastUpdated: new Date().toISOString(),
                requests: refreshedRequestArray
            }
        };
    }
    const reusableDraft = matchingRequests.find((record) => {
        return record.status === 'draft' || record.status === 'blocked' || daysSince(record.lastUpdatedAt) > 60;
    });
    const newRecord = {
        id: `req_${String(database.requests.length + 1).padStart(3, '0')}`,
        request: generationContext.requestedWork,
        requester: generationContext.requester,
        workstream: 'AI Engineering',
        status: 'proposed',
        lastUpdatedAt: new Date().toISOString().slice(0, 10),
        figmaUrl: generationContext.figmaDesign.figmaUrl,
        figmaDesignSpecPath: generationContext.figmaDesign.designSpecPath,
        figmaPluginPayloadPath: generationContext.figmaDesign.pluginPayloadPath,
        designBrief: generationContext.designBrief,
        llmSummary: generationContext.reactGeneration.summary,
        acceptanceCriteria: generationContext.designBrief.acceptanceCriteria,
        implementationPlan: generationContext.designBrief.implementationPlan,
        riskLevel: generationContext.designBrief.riskLevel,
        generatedPreviewHtml: generationContext.reactGeneration.previewHtml,
        generatedFiles: generationContext.reactGeneration.generatedFiles.map((file) => file.path),
        uiQualityScore: generationContext.uiQualityReview?.score,
        uiQualityFindings: generationContext.uiQualityReview?.findings
    };
    const updatedRequestArray = reusableDraft
        ? database.requests.map((record) => record.id === reusableDraft.id
            ? {
                ...record,
                requester: generationContext.requester,
                request: generationContext.requestedWork,
                status: 'proposed',
                lastUpdatedAt: new Date().toISOString().slice(0, 10),
                figmaUrl: generationContext.figmaDesign.figmaUrl,
                figmaDesignSpecPath: generationContext.figmaDesign.designSpecPath,
                figmaPluginPayloadPath: generationContext.figmaDesign.pluginPayloadPath,
                designBrief: generationContext.designBrief,
                llmSummary: generationContext.reactGeneration.summary,
                acceptanceCriteria: generationContext.designBrief.acceptanceCriteria,
                implementationPlan: generationContext.designBrief.implementationPlan,
                riskLevel: generationContext.designBrief.riskLevel,
                generatedPreviewHtml: generationContext.reactGeneration.previewHtml,
                generatedFiles: generationContext.reactGeneration.generatedFiles.map((file) => file.path),
                uiQualityScore: generationContext.uiQualityReview?.score,
                uiQualityFindings: generationContext.uiQualityReview?.findings
            }
            : record)
        : [...database.requests, newRecord];
    return {
        ...generationContext,
        previousOwner: reusableDraft?.requester ?? 'new delivery request',
        requestId: reusableDraft?.id ?? newRecord.id,
        analysisStatus: reusableDraft ? 'updated_existing' : 'new_request',
        updatedRequestArray,
        database: {
            ...database,
            lastUpdated: new Date().toISOString(),
            requests: updatedRequestArray
        }
    };
}
// Persists React, design, and implementation-plan artifacts through the MCP filesystem tool.
async function persistGeneratedArtifacts(results) {
    const planPath = `docs/design-to-react-${results.requestId}.md`;
    const planContent = [
        `# ${results.designBrief.brandName} Design-To-React Delivery`,
        '',
        `Requester: ${results.requester}`,
        `Prompt: ${results.requestedWork}`,
        `Risk: ${results.designBrief.riskLevel}`,
        `Figma design spec: ${results.figmaDesign.designSpecPath}`,
        `Figma plugin payload: ${results.figmaDesign.pluginPayloadPath}`,
        '',
        '## LLM Summary',
        results.reactGeneration.summary,
        '',
        '## UI Quality Review',
        `Score: ${results.uiQualityReview?.score ?? 'not reviewed'}`,
        `Passed: ${results.uiQualityReview?.passed ?? false}`,
        ...(results.uiQualityReview?.findings ?? ['No UI quality findings were recorded.']).map((item) => `- ${item}`),
        '',
        '## Acceptance Criteria',
        ...results.designBrief.acceptanceCriteria.map((item) => `- ${item}`),
        '',
        '## Implementation Plan',
        ...results.designBrief.implementationPlan.map((item) => `- ${item}`),
        '',
        '## Generated Files',
        ...results.reactGeneration.generatedFiles.map((file) => `- ${file.path}`)
    ].join('\n');
    // Generated app source files are kept in the feature branch PR and are not written to host runtime storage.
    const nonGeneratedAppArtifacts = results.reactGeneration.generatedFiles.filter((file) => !file.path.replace(/\\/g, '/').startsWith('generated-app/'));
    await Promise.all([
        ...nonGeneratedAppArtifacts.map((file) => writeGeneratedArtifactViaMcp(file)),
        writeGeneratedArtifactViaMcp({ path: planPath, content: planContent })
    ]);
    const updatedRequestArray = results.updatedRequestArray.map((record) => record.id === results.requestId
        ? {
            ...record,
            generatedFiles: [...results.reactGeneration.generatedFiles.map((file) => file.path), planPath]
        }
        : record);
    return {
        ...results,
        updatedRequestArray,
        database: {
            ...results.database,
            requests: updatedRequestArray
        }
    };
}
// Applies regenerated outputs back into the delivery database and writes files so the same PR branch can be updated.
async function persistReviewIteration(results, review, reactGeneration) {
    const updatedRequestArray = results.updatedRequestArray.map((record) => record.id === results.requestId
        ? {
            ...record,
            llmSummary: reactGeneration.summary,
            generatedPreviewHtml: reactGeneration.previewHtml,
            generatedFiles: reactGeneration.generatedFiles.map((file) => file.path),
            uiQualityScore: review.score,
            uiQualityFindings: [
                ...review.findings,
                ...review.codeFindings,
                ...review.requirementFindings,
                ...review.blockingIssues
            ]
        }
        : record);
    const updatedDatabase = {
        ...results.database,
        lastUpdated: new Date().toISOString(),
        requests: updatedRequestArray
    };
    const persistedArtifacts = await persistGeneratedArtifacts({
        ...results,
        reactGeneration,
        uiQualityReview: review,
        updatedRequestArray,
        database: updatedDatabase
    });
    const mutation = await writeDeliveryDatabaseViaMcp(persistedArtifacts.database);
    return {
        ...results,
        reactGeneration,
        uiQualityReview: review,
        updatedRequestArray: persistedArtifacts.updatedRequestArray,
        database: persistedArtifacts.database,
        databasePath: mutation.path,
        recordsUpdated: mutation.recordsUpdated
    };
}
// Coordinates PR creation, review-loop regeneration/comments, auto-merge-on-pass, and ticket closure.
async function createGovernanceEvidence(results) {
    const notes = [...(results.governanceNotes ?? [])];
    let prUrl = null;
    let prNumber = null;
    let prOwner = results.prOwner ?? null;
    let prRepo = results.prRepo ?? null;
    let branchName = results.branchName ?? null;
    let ticketId = results.ticketId ?? null;
    let ticketUrl = results.ticketUrl ?? null;
    const hasGitHubEnv = Boolean(optionalEnv('GITHUB_TOKEN') && optionalEnv('GITHUB_REPO_OWNER') && optionalEnv('GITHUB_REPO_NAME'));
    const maxAttempts = Math.max(1, Number(optionalEnv('REVIEW_MAX_ATTEMPTS') ?? '3'));
    let workingResults = results;
    let finalReview;
    let mergedToBase = false;
    let generatedUiUrl = buildGeneratedUiUrl(workingResults);
    console.log('Governance env check:', {
        hasGitHubToken: Boolean(optionalEnv('GITHUB_TOKEN')),
        hasGitHubOwner: Boolean(optionalEnv('GITHUB_REPO_OWNER')),
        hasGitHubRepo: Boolean(optionalEnv('GITHUB_REPO_NAME')),
        hasLinearApiKey: Boolean(optionalEnv('LINEAR_API_KEY')),
        hasLinearTeamId: Boolean(optionalEnv('LINEAR_TEAM_ID')),
        analysisStatus: results.analysisStatus,
        preProvisionedBranch: branchName,
        preProvisionedTicket: ticketId
    });
    try {
        if (hasGitHubEnv) {
            if (!branchName || !prOwner || !prRepo) {
                const branch = await createGitHubEvidenceBranch(results.requester);
                if (branch) {
                    branchName = branch.branchName;
                    prOwner = branch.prOwner;
                    prRepo = branch.prRepo;
                    notes.push('GitHub branch created during governance fallback.');
                }
            }
            if (branchName && prOwner && prRepo) {
                await syncEvidenceToGitHubBranch(workingResults, prOwner, prRepo, branchName);
                const pr = await ensureEvidencePullRequest(workingResults, prOwner, prRepo, branchName);
                prUrl = pr.prUrl;
                prNumber = pr.prNumber;
                notes.push('GitHub evidence PR raised for generated artifacts.');
            }
            else {
                notes.push('GitHub skipped: branch metadata unavailable.');
            }
        }
        else {
            notes.push('GitHub skipped: missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME in this runtime.');
        }
    }
    catch (error) {
        notes.push(`GitHub evidence PR failed: ${getErrorMessage(error)}`);
        console.error('GitHub governance evidence failure:', error);
    }
    finalReview = workingResults.uiQualityReview ?? await reviewReactUiQuality(workingResults);
    if (prNumber && prOwner && prRepo) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (finalReview.passed) {
                await postGitHubPrReviewComment(prOwner, prRepo, prNumber, 'Code Review Passed', [
                    `Overall score: ${finalReview.score}`,
                    `UI score: ${finalReview.uiQualityScore}`,
                    `Code score: ${finalReview.codeQualityScore}`,
                    `Requirement score: ${finalReview.requirementCoverageScore}`,
                    'Result: ready to merge.'
                ]);
                break;
            }
            await postGitHubPrReviewComment(prOwner, prRepo, prNumber, `Code Review Attempt ${attempt} Failed`, [
                `Overall score: ${finalReview.score}`,
                `UI score: ${finalReview.uiQualityScore}`,
                `Code score: ${finalReview.codeQualityScore}`,
                `Requirement score: ${finalReview.requirementCoverageScore}`,
                '',
                'Findings:',
                ...finalReview.findings.map((item) => `- ${item}`),
                '',
                'Code findings:',
                ...(finalReview.codeFindings.length > 0 ? finalReview.codeFindings : ['- None supplied by reviewer']).map((item) => `- ${item}`),
                '',
                'Requirement findings:',
                ...(finalReview.requirementFindings.length > 0 ? finalReview.requirementFindings : ['- None supplied by reviewer']).map((item) => `- ${item}`),
                '',
                'Blocking issues:',
                ...(finalReview.blockingIssues.length > 0 ? finalReview.blockingIssues : ['- None supplied by reviewer']).map((item) => `- ${item}`),
                '',
                'Regeneration prompt:',
                finalReview.regenerationPrompt
            ]);
            if (attempt === maxAttempts) {
                notes.push(`Code review failed after ${maxAttempts} attempt(s); PR left open for manual changes.`);
                break;
            }
            const regenerated = await generateReactFromFigmaDesign(workingResults, finalReview.regenerationPrompt);
            const regeneratedReview = await reviewReactUiQuality(regenerated);
            workingResults = await persistReviewIteration(workingResults, regeneratedReview, regenerated.reactGeneration);
            finalReview = regeneratedReview;
            await syncEvidenceToGitHubBranch(workingResults, prOwner, prRepo, branchName ?? workingResults.branchName ?? '');
            notes.push(`Regenerated UI and pushed review iteration ${attempt + 1} to the same PR branch.`);
        }
        if (finalReview.passed) {
            try {
                const mergeResult = await mergeGitHubPrAfterReview(prOwner, prRepo, prNumber, workingResults.requestId);
                notes.push(mergeResult);
                mergedToBase = true;
                notes.push(await triggerRailwayDeployment());
                notes.push(await waitForRailwayGeneratedUi(generatedUiUrl));
            }
            catch (error) {
                notes.push(`GitHub merge failed after passing review: ${getErrorMessage(error)}`);
            }
        }
    }
    else {
        notes.push('PR review loop skipped because PR metadata was unavailable.');
    }
    if (ticketId && mergedToBase) {
        try {
            const ticketUpdate = await closeLinearTicketAfterMerge(ticketId, workingResults.requestId);
            notes.push(ticketUpdate);
        }
        catch (error) {
            notes.push(`Linear ticket close failed: ${getErrorMessage(error)}`);
        }
    }
    const createdCount = [prUrl, ticketUrl].filter(Boolean).length;
    const governanceStatus = mergedToBase
        ? 'created'
        : createdCount === 0
            ? 'skipped'
            : 'partial';
    generatedUiUrl = buildGeneratedUiUrl(workingResults);
    return {
        ...workingResults,
        uiQualityReview: finalReview,
        prUrl,
        prNumber,
        prOwner,
        prRepo,
        branchName,
        ticketId,
        ticketUrl,
        generatedUiUrl,
        governanceStatus,
        governanceNotes: notes,
        releaseReady: mergedToBase
    };
}
// ---------------------------------------------------------
// NODE 5: Mastra Multi-Step Orchestration State Machine
// ---------------------------------------------------------
// Defines the governance intake step that creates a ticket and branch before design/code generation starts.
const governanceIntakeStep = createStep({
    id: 'provisionGovernanceIntake',
    description: 'Creates the Linear intake ticket and GitHub branch before UI generation.',
    inputSchema: executionContextSchema,
    outputSchema: executionContextSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 1: Governance Intake Agent...');
        return provisionGovernanceIntake(inputData);
    }
});
// Defines the LLM prompt-understanding agent that expands the Slack request into a design brief.
const designBriefStep = createStep({
    id: 'generateDesignBriefWithLlm',
    description: 'Uses an LLM to turn the Slack prompt into a structured domain-specific design brief.',
    inputSchema: executionContextSchema,
    outputSchema: designBriefResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 2: LLM Prompt Understanding Agent...');
        return generateDesignBriefWithLlm(inputData);
    }
});
// Defines the Figma design agent that prepares a real Figma plugin payload and design specification.
const figmaDesignStep = createStep({
    id: 'createFigmaDesign',
    description: 'Creates Figma design artifacts from the LLM design brief.',
    inputSchema: designBriefResultsSchema,
    outputSchema: figmaDesignResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 3: Figma Design Agent...');
        return createFigmaDesignFromBrief(inputData);
    }
});
// Defines the React code generator agent that converts the Figma design artifact into frontend files.
const reactGenerationStep = createStep({
    id: 'generateReactFromFigmaDesign',
    description: 'Generates React code from the Figma design artifact.',
    inputSchema: figmaDesignResultsSchema,
    outputSchema: reactGenerationResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 4: React Code Generator Agent...');
        return generateReactFromFigmaDesign(inputData);
    }
});
// Defines the Mastra analysis step that reads delivery state through MCP and creates or updates a request.
const analysisStep = createStep({
    id: 'runAIRequestAnalysis',
    description: 'Creates or updates the delivery database record for the generated UI request.',
    inputSchema: reactGenerationResultsSchema,
    outputSchema: analysisResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 5: Delivery Record Agent...');
        return runDeliveryAnalysis(inputData);
    }
});
// Defines the MCP artifact persistence step that writes generated React and documentation files.
const mcpArtifactStep = createStep({
    id: 'persistGeneratedArtifacts',
    description: 'Persists generated React, Figma, and delivery-plan artifacts through MCP.',
    inputSchema: analysisResultsSchema,
    outputSchema: analysisResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 6: MCP Generated Artifact Mutation...');
        return persistGeneratedArtifacts(inputData);
    }
});
// Defines the Mastra mutation step that writes the updated delivery database through the MCP tool layer.
const mcpMutationStep = createStep({
    id: 'mutateDeliveryDatabase',
    description: 'Persists the AI engineering delivery record through the MCP filesystem server.',
    inputSchema: analysisResultsSchema,
    outputSchema: mutationResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 7: MCP Delivery Database Mutation...');
        const mutation = await writeDeliveryDatabaseViaMcp(inputData.database);
        return {
            ...inputData,
            databasePath: mutation.path,
            recordsUpdated: mutation.recordsUpdated
        };
    }
});
// Defines the Mastra notification step that sends the completed workflow result back to Slack.
const slackDispatchStep = createStep({
    id: 'dispatchSlackInteractiveCard',
    description: 'Sends the final Block Kit update to Slack after PR review/merge and ticket closure.',
    inputSchema: governanceResultsSchema,
    outputSchema: workflowResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 9: Slack Bot Agent Dispatch...');
        await dispatchSlackInteractiveCard(inputData);
        console.log('🚀 [Outbound Notification] Slack interactive layout card dispatched successfully.');
        return {
            status: 'success',
            requester: inputData.requester,
            requestedWork: inputData.requestedWork,
            designBrief: inputData.designBrief,
            figmaDesign: inputData.figmaDesign,
            reactGeneration: inputData.reactGeneration,
            previousOwner: inputData.previousOwner,
            requestId: inputData.requestId,
            analysisStatus: inputData.analysisStatus,
            databasePath: inputData.databasePath,
            recordsUpdated: inputData.recordsUpdated,
            prUrl: inputData.prUrl,
            prNumber: inputData.prNumber,
            prOwner: inputData.prOwner,
            prRepo: inputData.prRepo,
            ticketId: inputData.ticketId,
            ticketUrl: inputData.ticketUrl,
            generatedUiUrl: inputData.generatedUiUrl,
            governanceStatus: inputData.governanceStatus,
            governanceNotes: inputData.governanceNotes,
            releaseReady: inputData.releaseReady,
            slackDispatched: true
        };
    }
});
// Defines the Mastra governance step that creates GitHub and Linear records before Slack receives the final delivery update.
const governanceStep = createStep({
    id: 'createGovernanceEvidence',
    description: 'Raises PR, runs code/business/UI review loop, merges on pass, and closes the ticket.',
    inputSchema: mutationResultsSchema,
    outputSchema: governanceResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 8: GitHub + Linear Governance Agents...');
        return createGovernanceEvidence(inputData);
    }
});
// Wires the Mastra workflow order from analysis, to MCP mutation, to governance, to Slack dispatch.
const engineeringDeliveryWorkflow = createWorkflow({
    id: 'DesignToReactDeliveryFlow',
    description: 'Slack prompt to LLM/Figma/React to MCP/GitHub/Linear/Railway workflow loop.',
    inputSchema: executionContextSchema,
    outputSchema: workflowResultsSchema
})
    .then(governanceIntakeStep)
    .then(designBriefStep)
    .then(figmaDesignStep)
    .then(reactGenerationStep)
    .then(analysisStep)
    .then(mcpArtifactStep)
    .then(mcpMutationStep)
    .then(governanceStep)
    .then(slackDispatchStep)
    .commit();
// Instantiates Mastra and registers the engineering delivery workflow for runtime execution.
const mastra = new Mastra({
    workflows: {
        engineeringDeliveryWorkflow
    }
});
// Exposes a small orchestrator API so Express and local simulation can run the Mastra workflow by name.
export const deliveryOrchestrator = {
    name: 'DesignToReactDeliveryFlow',
    async execute(context) {
        try {
            const workflow = mastra.getWorkflow('engineeringDeliveryWorkflow');
            const run = await workflow.createRun();
            const result = await run.start({ inputData: context });
            if (result.status !== 'success') {
                throw result.status === 'failed' ? result.error : new Error(`Workflow exited with status ${result.status}`);
            }
            console.log('✅ Orchestration completed successfully.');
            return result.result;
        }
        catch (error) {
            console.error('❌ Orchestration runtime failure:', error);
            throw error;
        }
    }
};
// ---------------------------------------------------------
// RUNTIME INTAKE INTERFACE SIMULATOR
// ---------------------------------------------------------
// Runs the workflow locally with sample Slack-style input when you want to test without sending a Slack request.
async function simulateSlackIntakeCommand() {
    console.log('Initializing AI Engineering Delivery Pipeline...');
    const executionContext = {
        requester: 'product.manager@company.com',
        requestedWork: 'Build a modern landing page for a fintech startup'
    };
    const runtimeResults = await deliveryOrchestrator.execute(executionContext);
    console.log('\n=======================================================');
    console.log('CHATOPS INTERACTIVE CONTROL CARD GENERATED SUCCESSFULLY');
    console.log('=======================================================');
    console.log(runtimeResults);
}
// Sends a consistent JSON HTTP response from Express route handlers.
function sendJson(response, statusCode, body) {
    response.status(statusCode).json(body);
}
// Starts the Express service, exposes Slack intake routes, generated UI routes, Figma payload routes, and health checks.
async function startServer() {
    const app = express();
    const port = Number(process.env.PORT ?? 3000);
    const shouldUseExactPort = Boolean(process.env.PORT);
    app.use(express.urlencoded({
        extended: false,
        verify: (request, _response, buffer) => {
            request.rawBody = buffer.toString('utf-8');
        }
    }));
    app.use(express.json({
        verify: (request, _response, buffer) => {
            request.rawBody = buffer.toString('utf-8');
        }
    }));
    // Root endpoint confirms the service is alive and advertises the major POC components.
    app.get('/', (_request, response) => {
        sendJson(response, 200, {
            service: 'ai-engineering-delivery-agent',
            status: 'ok',
            intake: 'Express',
            orchestrator: 'Mastra DesignToReactDeliveryFlow',
            contextLayer: 'MCP Filesystem Server',
            llmAgent: optionalEnv('OPENAI_MODEL') ?? 'gpt-4o-mini',
            figmaAgent: 'Figma design spec + live plugin session payload',
            reactGenerator: 'Figma design artifact to React/Vite code generator',
            governanceAgents: ['GitHub PR', 'Linear ticket'],
            deploymentAgent: 'Railway-hosted generated UI',
            slackCommandEndpoint: 'POST /api/slack/command',
            generatedUiEndpoint: 'GET /generated/:requestId',
            figmaPluginSessionEndpoint: 'GET /api/figma/session/:requestId'
        });
    });
    // Health endpoint gives Railway or local checks a lightweight status response.
    app.get('/health', (_request, response) => {
        sendJson(response, 200, { status: 'ok' });
    });
    // Figma plugin endpoints expose generated design specs to a live Figma plugin session.
    app.options('/api/figma/session/:requestId', (_request, response) => {
        response.set('Access-Control-Allow-Origin', '*');
        response.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        response.set('Access-Control-Allow-Headers', 'content-type');
        response.status(204).send();
    });
    app.get('/api/figma/session/:requestId', (request, response) => {
        response.set('Access-Control-Allow-Origin', '*');
        try {
            sendJson(response, 200, buildFigmaPluginSessionPayload(request.params.requestId));
        }
        catch (error) {
            sendJson(response, 404, {
                status: 'not_found',
                message: getErrorMessage(error)
            });
        }
    });
    // Generated UI endpoint serves the live Railway page returned to Slack for each prompt.
    app.get('/generated/:requestId', (request, response) => {
        try {
            response.status(200).type('html').send(renderGeneratedUi(request.params.requestId));
        }
        catch (error) {
            sendJson(response, 404, {
                status: 'not_found',
                message: getErrorMessage(error)
            });
        }
    });
    // Slack slash-command endpoint acknowledges the request quickly and launches the Mastra workflow asynchronously.
    app.post('/api/slack/command', async (request, response) => {
        const bodyData = request.rawBody ?? JSON.stringify(request.body ?? {});
        console.log('📥 [Incoming Request] Received Slash Command invocation from Slack. Raw payload:', bodyData);
        const { requester, requestedWork } = parseSlackCommandText(request.body?.text, request.body?.user_name ?? request.body?.user_id);
        response.status(200).type('text/plain').send(`⏳ Generating UI for ${requestedWork}. I will post the Railway URL here when it is ready...`);
        try {
            await deliveryOrchestrator.execute({ requester, requestedWork });
        }
        catch (error) {
            console.error('❌ Slack endpoint runtime failure:', error);
        }
    });
    // Binds the Express app to a port and auto-increments locally if the default port is already in use.
    const listen = (targetPort) => {
        const server = app.listen(targetPort, () => {
            console.log(`AI engineering delivery agent service listening on port ${targetPort}`);
        });
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE' && !shouldUseExactPort) {
                console.warn(`Port ${targetPort} is already in use. Trying ${targetPort + 1}...`);
                setTimeout(() => listen(targetPort + 1), 10);
                return;
            }
            console.error(error.message);
            process.exitCode = 1;
        });
    };
    listen(port);
}
// ---------------------------------------------------------
// PROCESS INITIALIZATION BOOTSTRAPPER
// ---------------------------------------------------------
// Chooses whether to run the HTTP service or the local simulation based on CLI arguments.
async function bootstrap() {
    if (process.env.RUN_PIPELINE_ON_START === 'true') {
        try {
            await simulateSlackIntakeCommand();
        }
        catch (error) {
            console.error('Simulation run encountered an operational fault:', getErrorMessage(error));
        }
    }
    await startServer();
}
bootstrap();

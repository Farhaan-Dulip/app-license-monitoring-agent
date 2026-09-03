import express, {} from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinearClient } from '@linear/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { Octokit } from '@octokit/rest';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LICENSE_DATABASE_PATH = path.join(__dirname, 'licenses.json');
const licenseSchema = z.object({
    id: z.string(),
    application: z.string(),
    assignedTo: z.string(),
    department: z.string(),
    status: z.string(),
    lastActiveDate: z.string()
});
const licenseDatabaseSchema = z.object({
    organization: z.string().optional(),
    lastUpdated: z.string().optional(),
    licenses: z.array(licenseSchema)
});
const executionContextSchema = z.object({
    targetUser: z.string().min(1),
    targetApp: z.string().min(1)
});
const auditResultsSchema = executionContextSchema.extend({
    reclaimedUser: z.string(),
    licenseId: z.string(),
    auditStatus: z.enum(['reallocated', 'already_assigned']),
    updatedLicenseArray: z.array(licenseSchema),
    database: licenseDatabaseSchema
});
const mutationResultsSchema = auditResultsSchema.extend({
    databasePath: z.string(),
    recordsUpdated: z.number()
});
const governanceResultsSchema = mutationResultsSchema.extend({
    prUrl: z.string().nullable(),
    prNumber: z.number().nullable(),
    prOwner: z.string().nullable(),
    prRepo: z.string().nullable(),
    branchName: z.string().nullable(),
    ticketId: z.string().nullable(),
    ticketUrl: z.string().nullable(),
    approvalUiUrl: z.string(),
    governanceStatus: z.enum(['created', 'skipped', 'partial']),
    governanceNotes: z.array(z.string())
});
const workflowResultsSchema = z.object({
    status: z.literal('success'),
    targetUser: z.string(),
    targetApp: z.string(),
    reclaimedUser: z.string(),
    licenseId: z.string(),
    auditStatus: z.enum(['reallocated', 'already_assigned']),
    databasePath: z.string(),
    recordsUpdated: z.number(),
    prUrl: z.string().nullable(),
    prNumber: z.number().nullable(),
    prOwner: z.string().nullable(),
    prRepo: z.string().nullable(),
    ticketId: z.string().nullable(),
    ticketUrl: z.string().nullable(),
    approvalUiUrl: z.string(),
    governanceStatus: z.enum(['created', 'skipped', 'partial']),
    governanceNotes: z.array(z.string()),
    slackDispatched: z.boolean()
});
function requiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function optionalEnv(name) {
    const value = process.env[name];
    return value && value.trim() ? value : undefined;
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function getOctokit() {
    const token = optionalEnv('GITHUB_TOKEN');
    return token ? new Octokit({ auth: token }) : undefined;
}
function getLinearClient() {
    const apiKey = optionalEnv('LINEAR_API_KEY');
    return apiKey ? new LinearClient({ apiKey }) : undefined;
}
function getPublicBaseUrl() {
    const configuredUrl = optionalEnv('APP_PUBLIC_URL') ?? optionalEnv('RAILWAY_PUBLIC_URL');
    if (configuredUrl) {
        return configuredUrl.replace(/\/$/, '');
    }
    const railwayDomain = optionalEnv('RAILWAY_PUBLIC_DOMAIN') ?? optionalEnv('RAILWAY_STATIC_URL');
    if (railwayDomain) {
        return `https://${railwayDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
    }
    return `http://localhost:${process.env.PORT ?? 3000}`;
}
function buildApprovalUiUrl(results, ticketId, githubPr) {
    const params = new URLSearchParams({
        user: results.targetUser,
        app: results.targetApp,
        status: results.auditStatus
    });
    if (ticketId) {
        params.set('ticketId', ticketId);
    }
    if (githubPr) {
        params.set('prNumber', String(githubPr.prNumber));
        params.set('prOwner', githubPr.prOwner);
        params.set('prRepo', githubPr.prRepo);
    }
    return `${getPublicBaseUrl()}/approval/${encodeURIComponent(results.licenseId)}?${params.toString()}`;
}
function daysSince(dateValue, now = new Date()) {
    const timestamp = Date.parse(dateValue);
    if (Number.isNaN(timestamp)) {
        return 0;
    }
    return Math.floor((now.getTime() - timestamp) / (1000 * 60 * 60 * 24));
}
// ---------------------------------------------------------
// NODE 1: MCP Filesystem Server for License Inventory State
// ---------------------------------------------------------
let mcpClientPromise;
async function getLicenseMcpClient() {
    if (!mcpClientPromise) {
        mcpClientPromise = initializeLicenseMcpClient();
    }
    return mcpClientPromise;
}
async function initializeLicenseMcpClient() {
    const server = new McpServer({
        name: 'accessguard-license-filesystem',
        version: '1.0.0'
    });
    server.registerTool('read_license_database', {
        title: 'Read License Database',
        description: 'Reads the root licenses.json inventory database.'
    }, async () => ({
        content: [
            {
                type: 'text',
                text: fs.readFileSync(LICENSE_DATABASE_PATH, 'utf-8')
            }
        ]
    }));
    server.registerTool('write_license_database', {
        title: 'Write License Database',
        description: 'Writes the optimized license inventory database back to root licenses.json.',
        inputSchema: {
            databaseJson: z.string()
        }
    }, async ({ databaseJson }) => {
        const parsedDatabase = licenseDatabaseSchema.parse(JSON.parse(databaseJson));
        fs.writeFileSync(LICENSE_DATABASE_PATH, `${JSON.stringify(parsedDatabase, null, 2)}\n`, 'utf-8');
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        ok: true,
                        path: LICENSE_DATABASE_PATH,
                        recordsUpdated: parsedDatabase.licenses.length
                    })
                }
            ]
        };
    });
    server.registerTool('find_license_availability', {
        title: 'Find License Availability',
        description: 'Returns aggregate inventory capacity and reclaim decisions for one application. No user or device identifiers are returned.',
        inputSchema: {
            appName: z.string().min(1).max(120)
        }
    }, async ({ appName }) => ({
        content: [{ type: 'text', text: JSON.stringify(await getLicenseAvailabilityMetrics(appName)) }]
    }));
    server.registerTool('summarize_reclaimable_licenses', {
        title: 'Summarize Reclaimable Licenses',
        description: 'Returns reclaimable decision counts grouped by application without user or device identifiers.'
    }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await getReclaimableLicenseSummary()) }]
    }));
    server.registerTool('get_completed_decisions', {
        title: 'Get Completed Decisions',
        description: 'Returns an aggregate completed-decision summary for one application without raw decision records.',
        inputSchema: {
            appName: z.string().min(1).max(120)
        }
    }, async ({ appName }) => ({
        content: [{ type: 'text', text: JSON.stringify(await getCompletedDecisionSummary(appName)) }]
    }));
    server.registerTool('get_reclaimable_license_details', {
        title: 'Get Reclaimable License Details',
        description: 'Returns reclaimable decision details for one application, including PC/device name and completion time. User identities and raw telemetry are excluded.',
        inputSchema: {
            appName: z.string().min(1).max(120)
        }
    }, async ({ appName }) => ({
        content: [{ type: 'text', text: JSON.stringify(await getReclaimableLicenseDetails(appName)) }]
    }));
    const client = new Client({
        name: 'accessguard-mastra-client',
        version: '1.0.0'
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}
async function readLicenseDatabaseViaMcp() {
    const client = await getLicenseMcpClient();
    const result = await client.callTool({
        name: 'read_license_database',
        arguments: {}
    });
    const content = result.content;
    const textContent = content.find((item) => item.type === 'text');
    if (!textContent) {
        throw new Error('MCP read_license_database returned no text content.');
    }
    return licenseDatabaseSchema.parse(JSON.parse(textContent.text));
}
async function writeLicenseDatabaseViaMcp(database) {
    const client = await getLicenseMcpClient();
    const result = await client.callTool({
        name: 'write_license_database',
        arguments: {
            databaseJson: JSON.stringify(database)
        }
    });
    const content = result.content;
    const textContent = content.find((item) => item.type === 'text');
    if (!textContent) {
        throw new Error('MCP write_license_database returned no text content.');
    }
    const parsedResult = z.object({
        ok: z.boolean(),
        path: z.string(),
        recordsUpdated: z.number()
    }).parse(JSON.parse(textContent.text));
    if (!parsedResult.ok) {
        throw new Error('MCP write_license_database reported a failed write.');
    }
    return {
        path: parsedResult.path,
        recordsUpdated: parsedResult.recordsUpdated
    };
}
// ---------------------------------------------------------
// NODE 2: License Optimization Logic
// ---------------------------------------------------------
async function runLicenseAudit(context) {
    const database = await readLicenseDatabaseViaMcp();
    const matchingLicenses = database.licenses.filter((license) => license.application === context.targetApp);
    const existingAssignedLicense = matchingLicenses.find((license) => license.assignedTo.toLowerCase() === context.targetUser.toLowerCase());
    if (existingAssignedLicense) {
        return {
            ...context,
            reclaimedUser: existingAssignedLicense.assignedTo,
            licenseId: existingAssignedLicense.id,
            auditStatus: 'already_assigned',
            updatedLicenseArray: database.licenses,
            database
        };
    }
    const reclaimableLicense = matchingLicenses.find((license) => {
        const assignedTo = license.assignedTo.toLowerCase();
        return assignedTo.includes('ex-employee') || daysSince(license.lastActiveDate) > 60;
    });
    if (!reclaimableLicense) {
        throw new Error(`No reclaimable ${context.targetApp} license was found.`);
    }
    const updatedLicenseArray = database.licenses.map((license) => license.id === reclaimableLicense.id
        ? {
            ...license,
            assignedTo: context.targetUser,
            status: 'active',
            lastActiveDate: new Date().toISOString().slice(0, 10)
        }
        : license);
    return {
        ...context,
        reclaimedUser: reclaimableLicense.assignedTo,
        licenseId: reclaimableLicense.id,
        auditStatus: 'reallocated',
        updatedLicenseArray,
        database: {
            ...database,
            lastUpdated: new Date().toISOString(),
            licenses: updatedLicenseArray
        }
    };
}
// -----------------------------------------------------------------------
// NODE 3: Outgoing Slack Messenger (Dispatches Block Kit UI Elements)
// -----------------------------------------------------------------------
async function dispatchSlackInteractiveCard(results) {
    const webhookUrl = requiredEnv('SLACK_WEBHOOK_URL');
    const governanceLines = [
        `*Railway Approval UI:* <${results.approvalUiUrl}|Open approval portal>`,
        results.prUrl ? `*GitHub Evidence PR:* <${results.prUrl}|Review PR>` : '*GitHub Evidence PR:* Not created',
        results.ticketUrl ? `*Linear Governance Ticket:* <${results.ticketUrl}|View ticket>` : '*Linear Governance Ticket:* Not created',
        `*Governance Status:* ${results.governanceStatus}`,
        `*Governance Notes:* ${results.governanceNotes.join(' | ')}`
    ];
    const slackPayload = {
        blocks: [
            {
                type: 'header',
                text: { type: 'plain_text', text: '🔐 AccessGuard Approval Portal Ready' }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Target Assignment:* \`${results.targetUser}\`\n*Requested Platform:* *${results.targetApp}*\n*Compliance Status:* ${results.auditStatus === 'already_assigned' ? '🟡 User already has an active allocation.' : '🟢 Found inactive profile and reallocated an existing token.'}\n*Reclaimed From:* \`${results.reclaimedUser}\`\n*License ID:* \`${results.licenseId}\``
                }
            },
            {
                type: 'divider'
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Approval Surface:* Railway-hosted UI\n*Database Mutation:* \`${results.databasePath}\`\n*Records Scanned:* ${results.recordsUpdated}\n${governanceLines.join('\n')}\n*Financial Footprint:* *Net $0 variance*`
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        style: 'primary',
                        text: { type: 'plain_text', text: 'Open Railway Approval UI' },
                        url: results.approvalUiUrl
                    }
                ]
            }
        ]
    };
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(slackPayload)
    });
    if (!response.ok) {
        throw new Error(`Slack webhook rejected dispatch payload with ${response.status}: ${await response.text()}`);
    }
}
// ---------------------------------------------------------
// NODE 4: GitHub + Linear Governance Evidence
// ---------------------------------------------------------
async function createGitHubEvidencePr(results) {
    const octokit = getOctokit();
    const owner = optionalEnv('GITHUB_REPO_OWNER');
    const repo = optionalEnv('GITHUB_REPO_NAME');
    const baseBranch = optionalEnv('GITHUB_BASE_BRANCH') ?? 'develop';
    if (!octokit || !owner || !repo) {
        return null;
    }
    if (results.auditStatus === 'already_assigned') {
        return null;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const branchName = `audit/license-${results.targetUser.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;
    const updatedData = {
        organization: results.database.organization,
        lastUpdated: results.database.lastUpdated,
        licenses: results.updatedLicenseArray
    };
    const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseRef.object.sha
    });
    const { data: fileData } = await octokit.repos.getContent({
        owner,
        repo,
        path: 'licenses.json',
        ref: branchName
    });
    if (Array.isArray(fileData) || fileData.type !== 'file' || !fileData.sha) {
        throw new Error('Expected licenses.json to be a file in the target repository.');
    }
    await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: 'licenses.json',
        message: `[Governance] Reallocate ${results.targetApp} license to ${results.targetUser}`,
        content: Buffer.from(JSON.stringify(updatedData, null, 2)).toString('base64'),
        sha: fileData.sha,
        branch: branchName
    });
    const { data: pullRequest } = await octokit.pulls.create({
        owner,
        repo,
        title: `[License Reallocation] ${results.targetApp} -> ${results.targetUser}`,
        head: branchName,
        base: baseBranch,
        body: [
            'Automated governance evidence for Slack-triggered license reallocation.',
            '',
            `- Requested user: ${results.targetUser}`,
            `- Application: ${results.targetApp}`,
            `- Reclaimed from: ${results.reclaimedUser}`,
            `- License ID: ${results.licenseId}`
        ].join('\n')
    });
    return {
        prUrl: pullRequest.html_url,
        prNumber: pullRequest.number,
        prOwner: owner,
        prRepo: repo,
        branchName
    };
}
async function createLinearGovernanceTicket(results, prUrl) {
    const linear = getLinearClient();
    if (!linear) {
        return null;
    }
    const configuredTeamId = optionalEnv('LINEAR_TEAM_ID');
    let teamId = configuredTeamId;
    if (teamId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(teamId)) {
        const teams = await linear.teams();
        const matchingTeam = teams.nodes.find((team) => team.key.toLowerCase() === teamId?.toLowerCase() ||
            team.name.toLowerCase() === teamId?.toLowerCase());
        if (!matchingTeam) {
            throw new Error(`LINEAR_TEAM_ID must be a UUID, team key, or team name. Could not resolve "${teamId}".`);
        }
        teamId = matchingTeam.id;
    }
    if (!teamId) {
        const teams = await linear.teams();
        teamId = teams.nodes[0]?.id;
    }
    if (!teamId) {
        throw new Error('No Linear team was found. Set LINEAR_TEAM_ID or create a Linear team.');
    }
    const issue = await linear.createIssue({
        teamId,
        title: `[Governance] ${results.targetApp} license allocation for ${results.targetUser}`,
        description: [
            'Automated compliance ticket for Slack-triggered license allocation.',
            '',
            `Requested user: ${results.targetUser}`,
            `Application: ${results.targetApp}`,
            `Audit status: ${results.auditStatus}`,
            `Reclaimed from: ${results.reclaimedUser}`,
            `License ID: ${results.licenseId}`,
            prUrl ? `GitHub evidence PR: ${prUrl}` : 'GitHub evidence PR: not created'
        ].join('\n'),
        priority: 1
    });
    const issueDetails = await issue.issue;
    return issueDetails?.url ? { ticketId: issueDetails.id, ticketUrl: issueDetails.url } : null;
}
async function createGovernanceEvidence(results) {
    const notes = [];
    let prUrl = null;
    let prNumber = null;
    let prOwner = null;
    let prRepo = null;
    let branchName = null;
    let ticketId = null;
    let ticketUrl = null;
    const hasGitHubEnv = Boolean(optionalEnv('GITHUB_TOKEN') && optionalEnv('GITHUB_REPO_OWNER') && optionalEnv('GITHUB_REPO_NAME'));
    const hasLinearEnv = Boolean(optionalEnv('LINEAR_API_KEY'));
    console.log('Governance env check:', {
        hasGitHubToken: Boolean(optionalEnv('GITHUB_TOKEN')),
        hasGitHubOwner: Boolean(optionalEnv('GITHUB_REPO_OWNER')),
        hasGitHubRepo: Boolean(optionalEnv('GITHUB_REPO_NAME')),
        hasLinearApiKey: Boolean(optionalEnv('LINEAR_API_KEY')),
        hasLinearTeamId: Boolean(optionalEnv('LINEAR_TEAM_ID')),
        auditStatus: results.auditStatus
    });
    try {
        const pr = await createGitHubEvidencePr(results);
        if (pr) {
            prUrl = pr.prUrl;
            prNumber = pr.prNumber;
            prOwner = pr.prOwner;
            prRepo = pr.prRepo;
            branchName = pr.branchName;
            notes.push('GitHub evidence PR created.');
        }
        else if (!hasGitHubEnv) {
            notes.push('GitHub skipped: missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME in this runtime.');
        }
        else if (results.auditStatus === 'already_assigned') {
            notes.push('GitHub skipped: request was already_assigned, so no file change existed for a PR.');
        }
        else {
            notes.push('GitHub skipped: no PR was returned.');
        }
    }
    catch (error) {
        notes.push(`GitHub evidence PR failed: ${getErrorMessage(error)}`);
        console.error('GitHub governance evidence failure:', error);
    }
    try {
        const ticket = await createLinearGovernanceTicket(results, prUrl);
        if (ticket) {
            ticketId = ticket.ticketId;
            ticketUrl = ticket.ticketUrl;
            notes.push('Linear governance ticket created.');
        }
        else if (!hasLinearEnv) {
            notes.push('Linear skipped: missing LINEAR_API_KEY in this runtime.');
        }
        else {
            notes.push('Linear skipped: no ticket URL was returned.');
        }
    }
    catch (error) {
        notes.push(`Linear governance ticket failed: ${getErrorMessage(error)}`);
        console.error('Linear governance ticket failure:', error);
    }
    const createdCount = [prUrl, ticketUrl].filter(Boolean).length;
    const governanceStatus = createdCount === 2 ? 'created' : createdCount === 0 ? 'skipped' : 'partial';
    const githubPr = prNumber && prOwner && prRepo ? { prNumber, prOwner, prRepo } : null;
    const approvalUiUrl = buildApprovalUiUrl(results, ticketId, githubPr);
    return {
        ...results,
        prUrl,
        prNumber,
        prOwner,
        prRepo,
        branchName,
        ticketId,
        ticketUrl,
        approvalUiUrl,
        governanceStatus,
        governanceNotes: notes
    };
}
// ---------------------------------------------------------
// NODE 5: Mastra Multi-Step Orchestration State Machine
// ---------------------------------------------------------
const auditStep = createStep({
    id: 'runAIAudit',
    description: 'Scans license inventory through MCP and selects an idle seat.',
    inputSchema: executionContextSchema,
    outputSchema: auditResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 1: AI Audit...');
        return runLicenseAudit(inputData);
    }
});
const mcpMutationStep = createStep({
    id: 'mutateLicenseDatabase',
    description: 'Persists the optimized license inventory through the MCP filesystem server.',
    inputSchema: auditResultsSchema,
    outputSchema: mutationResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 2: MCP Filesystem Mutation...');
        const mutation = await writeLicenseDatabaseViaMcp(inputData.database);
        return {
            ...inputData,
            databasePath: mutation.path,
            recordsUpdated: mutation.recordsUpdated
        };
    }
});
const slackDispatchStep = createStep({
    id: 'dispatchSlackInteractiveCard',
    description: 'Sends the final Block Kit approval card to Slack.',
    inputSchema: governanceResultsSchema,
    outputSchema: workflowResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 4: Slack Interactive Dispatch...');
        await dispatchSlackInteractiveCard(inputData);
        console.log('🚀 [Outbound Notification] Slack interactive layout card dispatched successfully.');
        return {
            status: 'success',
            targetUser: inputData.targetUser,
            targetApp: inputData.targetApp,
            reclaimedUser: inputData.reclaimedUser,
            licenseId: inputData.licenseId,
            auditStatus: inputData.auditStatus,
            databasePath: inputData.databasePath,
            recordsUpdated: inputData.recordsUpdated,
            prUrl: inputData.prUrl,
            prNumber: inputData.prNumber,
            prOwner: inputData.prOwner,
            prRepo: inputData.prRepo,
            ticketId: inputData.ticketId,
            ticketUrl: inputData.ticketUrl,
            approvalUiUrl: inputData.approvalUiUrl,
            governanceStatus: inputData.governanceStatus,
            governanceNotes: inputData.governanceNotes,
            slackDispatched: true
        };
    }
});
const governanceStep = createStep({
    id: 'createGovernanceEvidence',
    description: 'Creates optional GitHub PR and Linear ticket evidence for the allocation.',
    inputSchema: mutationResultsSchema,
    outputSchema: governanceResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 3: GitHub + Linear Governance Evidence...');
        return createGovernanceEvidence(inputData);
    }
});
const licenseOptimizationWorkflow = createWorkflow({
    id: 'LicenseOptimizationFlow',
    description: 'Slack to Express/Mastra to MCP/license DB to Slack workflow loop.',
    inputSchema: executionContextSchema,
    outputSchema: workflowResultsSchema
})
    .then(auditStep)
    .then(mcpMutationStep)
    .then(governanceStep)
    .then(slackDispatchStep)
    .commit();
const mastra = new Mastra({
    workflows: {
        licenseOptimizationWorkflow
    }
});
export const licenseOrchestrator = {
    name: 'LicenseOptimizationFlow',
    async execute(context) {
        try {
            const workflow = mastra.getWorkflow('licenseOptimizationWorkflow');
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
async function simulateSlackIntakeCommand() {
    console.log('Initializing ChatOps Provisioning Engine Pipeline...');
    const executionContext = {
        targetUser: 'Amila@company.com',
        targetApp: 'MuleSoft Anypoint'
    };
    const runtimeResults = await licenseOrchestrator.execute(executionContext);
    console.log('\n=======================================================');
    console.log('CHATOPS INTERACTIVE CONTROL CARD GENERATED SUCCESSFULLY');
    console.log('=======================================================');
    console.log(runtimeResults);
}
function parseSlackCommandText(textValue) {
    const slackInputText = typeof textValue === 'string' ? textValue.trim() : '';
    const spaceIndex = slackInputText.indexOf(' ');
    if (spaceIndex === -1) {
        return {
            targetUser: 'Amila@company.com',
            targetApp: 'MuleSoft Anypoint'
        };
    }
    return {
        targetUser: slackInputText.substring(0, spaceIndex).trim(),
        targetApp: slackInputText.substring(spaceIndex + 1).trim()
    };
}
function sendJson(response, statusCode, body) {
    response.status(statusCode).json(body);
}
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function renderApprovalUi(licenseId, request) {
    const database = licenseDatabaseSchema.parse(JSON.parse(fs.readFileSync(LICENSE_DATABASE_PATH, 'utf-8')));
    const license = database.licenses.find((item) => item.id === licenseId);
    const targetUser = typeof request.query.user === 'string' ? request.query.user : license?.assignedTo ?? 'unknown';
    const targetApp = typeof request.query.app === 'string' ? request.query.app : license?.application ?? 'unknown';
    const auditStatus = typeof request.query.status === 'string' ? request.query.status : 'pending';
    const ticketId = typeof request.query.ticketId === 'string' ? request.query.ticketId : '';
    const prNumber = typeof request.query.prNumber === 'string' ? request.query.prNumber : '';
    const prOwner = typeof request.query.prOwner === 'string' ? request.query.prOwner : '';
    const prRepo = typeof request.query.prRepo === 'string' ? request.query.prRepo : '';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AccessGuard Approval</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; background: #101820; color: #eef4f8; display: grid; place-items: center; }
    main { width: min(760px, calc(100vw - 32px)); border: 1px solid #314554; background: #17242e; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    header { padding: 28px 32px 18px; border-bottom: 1px solid #314554; }
    h1 { margin: 0; font-size: 26px; letter-spacing: 0; }
    .sub { margin: 10px 0 0; color: #9eb1bd; line-height: 1.5; }
    section { padding: 28px 32px; }
    dl { display: grid; grid-template-columns: 180px 1fr; gap: 14px 18px; margin: 0; }
    dt { color: #9eb1bd; }
    dd { margin: 0; font-weight: 650; word-break: break-word; }
    .status { display: inline-flex; padding: 5px 9px; border: 1px solid #6dbd8b; color: #8fe3ad; background: rgba(109,189,139,.12); border-radius: 6px; }
    .actions { display: flex; gap: 12px; padding-top: 26px; flex-wrap: wrap; }
    button { border: 0; border-radius: 6px; color: #07130c; font-weight: 750; padding: 12px 16px; cursor: pointer; }
    .approve { background: #76d69a; }
    .block { background: #ff7d7d; }
    .result { color: #9eb1bd; min-height: 22px; margin-top: 18px; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>AccessGuard License Approval</h1>
      <p class="sub">Railway-hosted approval surface generated by the Mastra governance workflow.</p>
    </header>
    <section>
      <dl>
        <dt>Requested User</dt><dd>${escapeHtml(targetUser)}</dd>
        <dt>Application</dt><dd>${escapeHtml(targetApp)}</dd>
        <dt>License ID</dt><dd>${escapeHtml(licenseId)}</dd>
        <dt>Current Assignee</dt><dd>${escapeHtml(license?.assignedTo ?? 'unknown')}</dd>
        <dt>Audit Status</dt><dd><span class="status">${escapeHtml(auditStatus)}</span></dd>
        <dt>Linear Ticket ID</dt><dd>${escapeHtml(ticketId || 'not linked')}</dd>
        <dt>GitHub PR</dt><dd>${escapeHtml(prNumber && prOwner && prRepo ? `${prOwner}/${prRepo}#${prNumber}` : 'not linked')}</dd>
        <dt>Last Activity</dt><dd>${escapeHtml(license?.lastActiveDate ?? 'unknown')}</dd>
      </dl>
      <div class="actions">
        <button class="approve" data-decision="approved">Approve Allocation</button>
        <button class="block" data-decision="blocked">Block Provision</button>
      </div>
      <p id="result" class="result"></p>
    </section>
  </main>
  <script>
    const result = document.getElementById('result');
    document.querySelectorAll('button[data-decision]').forEach((button) => {
      button.addEventListener('click', async () => {
        const decision = button.dataset.decision;
        result.textContent = 'Submitting decision...';
        const response = await fetch('/api/approval/${encodeURIComponent(licenseId)}', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision,
            ticketId: ${JSON.stringify(ticketId)},
            prNumber: ${JSON.stringify(prNumber)},
            prOwner: ${JSON.stringify(prOwner)},
            prRepo: ${JSON.stringify(prRepo)}
          })
        });
        const payload = await response.json();
        result.textContent = payload.message || 'Decision recorded.';
      });
    });
  </script>
</body>
</html>`;
}
async function updateLinearTicketFromApproval(ticketId, decision, licenseId) {
    if (!ticketId) {
        return 'Linear ticket was not linked to this approval URL.';
    }
    const linear = getLinearClient();
    if (!linear) {
        return 'LINEAR_API_KEY is not configured; Linear ticket was not updated.';
    }
    const issue = await linear.issue(ticketId);
    const teamId = issue.teamId;
    if (!teamId) {
        throw new Error(`Linear issue ${ticketId} has no teamId.`);
    }
    const team = await linear.team(teamId);
    const states = await team.states();
    const desiredType = decision === 'approved' ? 'completed' : 'canceled';
    const fallbackNames = decision === 'approved'
        ? ['done', 'completed', 'complete']
        : ['canceled', 'cancelled', 'blocked'];
    const targetState = states.nodes.find((state) => state.type === desiredType)
        ?? states.nodes.find((state) => fallbackNames.includes(state.name.toLowerCase()));
    if (!targetState) {
        throw new Error(`Could not find a Linear ${desiredType} workflow state for team ${team.name}.`);
    }
    await linear.updateIssue(ticketId, { stateId: targetState.id });
    await linear.createComment({
        issueId: ticketId,
        body: `Railway approval portal decision: **${decision}** for license \`${licenseId}\`.`
    });
    return `Linear ticket moved to ${targetState.name}.`;
}
async function updateGitHubPrFromApproval(prOwner, prRepo, prNumberValue, decision, licenseId) {
    if (!prOwner || !prRepo || !prNumberValue) {
        return 'GitHub PR was not linked to this approval URL.';
    }
    const octokit = getOctokit();
    if (!octokit) {
        return 'GITHUB_TOKEN is not configured; GitHub PR was not updated.';
    }
    const pull_number = Number(prNumberValue);
    if (!Number.isInteger(pull_number) || pull_number <= 0) {
        throw new Error(`Invalid GitHub PR number: ${prNumberValue}`);
    }
    if (decision === 'approved') {
        await octokit.pulls.merge({
            owner: prOwner,
            repo: prRepo,
            pull_number,
            merge_method: 'squash',
            commit_title: `[Governance Approved] Merge license allocation ${licenseId}`
        });
        return `GitHub PR #${pull_number} merged.`;
    }
    await octokit.pulls.update({
        owner: prOwner,
        repo: prRepo,
        pull_number,
        state: 'closed'
    });
    await octokit.issues.createComment({
        owner: prOwner,
        repo: prRepo,
        issue_number: pull_number,
        body: `Railway approval portal decision: **blocked** for license \`${licenseId}\`. Closing this PR without merge.`
    });
    return `GitHub PR #${pull_number} closed without merge.`;
}
function assistantAppName(record) {
    return String(record.appName ?? record.app_name ?? record.name ?? record.application ?? '');
}
async function callAssistantToolViaMcp(name, argumentsValue) {
    const allowedTools = new Set([
        'find_license_availability',
        'summarize_reclaimable_licenses',
        'get_completed_decisions',
        'get_reclaimable_license_details'
    ]);
    if (!allowedTools.has(name))
        throw new Error(`Assistant requested unsupported MCP tool: ${name}`);
    const client = await getLicenseMcpClient();
    const result = await client.callTool({ name, arguments: argumentsValue });
    const content = result.content;
    const textContent = content.find((item) => item.type === 'text');
    if (!textContent)
        throw new Error(`MCP ${name} returned no text content.`);
    return textContent.text;
}
function assistantDecisionText(record) {
    return [record.status, record.decision, record.recommendation, record.result, record.reason]
        .filter(Boolean)
        .join(' ');
}
function isReclaimableDecision(record) {
    return /reclaim|available|unused|inactive|underutilized|release/i.test(assistantDecisionText(record));
}
function assistantNumber(record, keys) {
    const key = keys.find((candidate) => record[candidate] !== undefined);
    return key ? Number(record[key] || 0) : 0;
}
function escapeMongoRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function assistantAppMatcher(appName) {
    const normalized = appName.trim().replace(/\.exe$/i, '');
    return new RegExp(`^${escapeMongoRegex(normalized)}(?:\\.exe)?$`, 'i');
}
async function withAssistantCollections(operation) {
    const mongoClient = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
    try {
        await mongoClient.connect();
        const database = mongoClient.db(process.env.MONGO_DATABASE || 'app-usage-monitoring');
        return await operation(database.collection('onboarded_licenses'), database.collection('evaluation_decisions'));
    }
    finally {
        await mongoClient.close();
    }
}
async function getLicenseAvailabilityMetrics(appName) {
    return withAssistantCollections(async (licenseCollection, decisionCollection) => {
        const appMatcher = assistantAppMatcher(appName);
        const appQuery = {
            $or: [{ appName: appMatcher }, { app_name: appMatcher }, { name: appMatcher }, { application: appMatcher }]
        };
        const [licenses, decisions] = await Promise.all([
            licenseCollection.find(appQuery).limit(100).toArray(),
            decisionCollection.find(appQuery).sort({ completed_date: -1, completed_time: -1 }).limit(100).toArray()
        ]);
        const totalSeats = licenses.reduce((total, record) => total + assistantNumber(record, ['totalSeats', 'total_seats', 'seats', 'quantity']), 0);
        const assignedSeats = licenses.reduce((total, record) => total + assistantNumber(record, ['assignedSeats', 'assigned_seats', 'usedSeats']), 0);
        const explicitlyAvailable = licenses.reduce((total, record) => total + assistantNumber(record, ['availableSeats', 'available_seats']), 0);
        const inventoryAvailable = explicitlyAvailable || Math.max(0, totalSeats - assignedSeats);
        const reclaimableDecisions = decisions.filter(isReclaimableDecision).length;
        return {
            application: appName.trim(),
            inventoryRecords: licenses.length,
            completedDecisions: decisions.length,
            totalSeats,
            assignedSeats,
            inventoryAvailable,
            reclaimableDecisions,
            potentiallyAvailable: Math.max(inventoryAvailable, reclaimableDecisions),
            caveat: 'Potentially available seats require confirmation against the latest assignment state.'
        };
    });
}
async function getReclaimableLicenseSummary() {
    return withAssistantCollections(async (_licenseCollection, decisionCollection) => {
        const decisions = await decisionCollection.find({}).limit(500).toArray();
        const reclaimable = decisions.filter(isReclaimableDecision);
        const byApplication = reclaimable.reduce((counts, record) => {
            const name = assistantAppName(record) || 'Unknown application';
            counts[name] = (counts[name] || 0) + 1;
            return counts;
        }, {});
        return {
            completedDecisionsReviewed: decisions.length,
            reclaimableDecisionCount: reclaimable.length,
            byApplication: Object.fromEntries(Object.entries(byApplication).sort((first, second) => second[1] - first[1]).slice(0, 20))
        };
    });
}
async function getCompletedDecisionSummary(appName) {
    return withAssistantCollections(async (_licenseCollection, decisionCollection) => {
        const appMatcher = assistantAppMatcher(appName);
        const decisions = await decisionCollection
            .find({ $or: [{ appName: appMatcher }, { app_name: appMatcher }, { name: appMatcher }, { application: appMatcher }] })
            .sort({ completed_date: -1, completed_time: -1 })
            .limit(200)
            .toArray();
        const categories = decisions.reduce((counts, record) => {
            const category = assistantDecisionText(record).trim() || 'Unspecified';
            counts[category] = (counts[category] || 0) + 1;
            return counts;
        }, {});
        return {
            application: appName.trim(),
            completedDecisionCount: decisions.length,
            reclaimableDecisionCount: decisions.filter(isReclaimableDecision).length,
            categories: Object.fromEntries(Object.entries(categories).slice(0, 20))
        };
    });
}
async function getReclaimableLicenseDetails(appName) {
    return withAssistantCollections(async (_licenseCollection, decisionCollection) => {
        const appMatcher = assistantAppMatcher(appName);
        const decisions = await decisionCollection
            .find({ $or: [{ appName: appMatcher }, { app_name: appMatcher }, { name: appMatcher }, { application: appMatcher }] })
            .sort({ completed_date: -1, completed_time: -1 })
            .limit(100)
            .toArray();
        const details = decisions.filter(isReclaimableDecision).slice(0, 50).map((record) => ({
            application: assistantAppName(record) || appName.trim(),
            pcName: String(record.pcName ?? record.pc_name ?? record.device_name ?? record.device_id ?? 'Not recorded'),
            decision: assistantDecisionText(record) || 'Reclaimable',
            completedDate: record.completed_date ?? null,
            completedTime: record.completed_time ?? null,
            timeZone: record.time_zone ?? null
        }));
        return {
            application: appName.trim(),
            reclaimableDecisionCount: details.length,
            details,
            excludedFields: ['user identity', 'raw telemetry']
        };
    });
}
async function buildFallbackAssistantAnswer(question) {
    const mongoClient = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
    try {
        await mongoClient.connect();
        const database = mongoClient.db(process.env.MONGO_DATABASE || 'app-usage-monitoring');
        const [licenses, decisions] = await Promise.all([
            database.collection('onboarded_licenses').find({}).limit(500).toArray(),
            database
                .collection('evaluation_decisions')
                .find({})
                .sort({ completed_date: -1, completed_time: -1 })
                .limit(500)
                .toArray()
        ]);
        const records = [...licenses, ...decisions];
        const normalizedQuestion = question.toLowerCase();
        const appNames = [...new Set(records.map(assistantAppName).filter(Boolean))].sort((first, second) => second.length - first.length);
        const requestedApp = appNames.find((name) => normalizedQuestion.includes(name.toLowerCase()));
        if (requestedApp) {
            const matchesApp = (record) => assistantAppName(record).toLowerCase() === requestedApp.toLowerCase();
            const appLicenses = licenses.filter(matchesApp);
            const appDecisions = decisions.filter(matchesApp);
            const reclaimable = appDecisions.filter(isReclaimableDecision);
            const totalSeats = appLicenses.reduce((total, record) => total + assistantNumber(record, ['totalSeats', 'total_seats', 'seats', 'quantity']), 0);
            const assignedSeats = appLicenses.reduce((total, record) => total + assistantNumber(record, ['assignedSeats', 'assigned_seats', 'usedSeats']), 0);
            const explicitAvailable = appLicenses.reduce((total, record) => total + assistantNumber(record, ['availableSeats', 'available_seats']), 0);
            const inventoryAvailable = explicitAvailable || Math.max(0, totalSeats - assignedSeats);
            const availability = Math.max(inventoryAvailable, reclaimable.length);
            if (/available|availability|free|open|request|access/.test(normalizedQuestion)) {
                return {
                    answer: availability > 0
                        ? `Yes. I found ${availability} potentially available ${requestedApp} license${availability === 1 ? '' : 's'}. ${inventoryAvailable} are indicated by inventory capacity and ${reclaimable.length} by completed reclaim decisions. Confirm the latest assignment state before allocating a seat.`
                        : `I could not confirm an available ${requestedApp} license. I found ${appLicenses.length} inventory record${appLicenses.length === 1 ? '' : 's'} and ${appDecisions.length} completed decision${appDecisions.length === 1 ? '' : 's'}, with no free capacity or reclaim recommendation recorded.`,
                    recordsReviewed: records.length
                };
            }
            return {
                answer: `${requestedApp} has ${appLicenses.length} inventory record${appLicenses.length === 1 ? '' : 's'}, ${appDecisions.length} completed decision${appDecisions.length === 1 ? '' : 's'}, and ${reclaimable.length} potentially reclaimable license${reclaimable.length === 1 ? '' : 's'}.`,
                recordsReviewed: records.length
            };
        }
        const reclaimable = decisions.filter(isReclaimableDecision);
        if (/reclaim|unused|inactive|underutilized/.test(normalizedQuestion)) {
            const appCounts = reclaimable.reduce((counts, record) => {
                const name = assistantAppName(record) || 'Unknown application';
                counts[name] = (counts[name] || 0) + 1;
                return counts;
            }, {});
            const leaders = Object.entries(appCounts)
                .sort((first, second) => second[1] - first[1])
                .slice(0, 5)
                .map(([name, count]) => `${name} (${count})`)
                .join(', ');
            return {
                answer: `There are ${reclaimable.length} completed decisions indicating reclaimable or underused licenses.${leaders ? ` The leading applications are ${leaders}.` : ''}`,
                recordsReviewed: records.length
            };
        }
        return {
            answer: `I reviewed ${records.length} current MongoDB license and decision records. I can answer questions about availability, reclaimable licenses, inactive usage, and completed decisions. Try asking about a specific application such as Postman.`,
            recordsReviewed: records.length
        };
    }
    finally {
        await mongoClient.close();
    }
}
const assistantOpenAITools = [
    {
        type: 'function', name: 'find_license_availability',
        description: 'Find aggregate license availability for one named application.',
        parameters: { type: 'object', properties: { appName: { type: 'string' } }, required: ['appName'], additionalProperties: false },
        strict: true
    },
    {
        type: 'function', name: 'summarize_reclaimable_licenses',
        description: 'Summarize reclaimable or underused license decisions across applications.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        strict: true
    },
    {
        type: 'function', name: 'get_completed_decisions',
        description: 'Get aggregate completed decision metrics for one named application.',
        parameters: { type: 'object', properties: { appName: { type: 'string' } }, required: ['appName'], additionalProperties: false },
        strict: true
    },
    {
        type: 'function', name: 'get_reclaimable_license_details',
        description: 'Get reclaimable decision details for an application, including PC/device name and completion time.',
        parameters: { type: 'object', properties: { appName: { type: 'string' } }, required: ['appName'], additionalProperties: false },
        strict: true
    }
];
function openAIText(payload) {
    if (typeof payload.output_text === 'string')
        return payload.output_text.trim();
    return (payload.output || []).flatMap((item) => item.content || [])
        .filter((content) => content.type === 'output_text' && typeof content.text === 'string')
        .map((content) => content.text).join('\n').trim();
}
async function createOpenAIResponse(body) {
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${requiredEnv('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const payload = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(payload.error?.message || `OpenAI returned status ${response.status}`);
    return payload;
}
function countReviewedToolRecords(toolResult) {
    try {
        const value = JSON.parse(toolResult);
        return Number(value.completedDecisionsReviewed || value.completedDecisionCount || value.reclaimableDecisionCount || 0) + Number(value.inventoryRecords || 0);
    }
    catch {
        return 0;
    }
}
async function answerAssistantQuestion(question, conversation) {
    if (!process.env.OPENAI_API_KEY?.trim()) {
        return { ...(await buildFallbackAssistantAnswer(question)), source: 'monitoring-agent-fallback' };
    }
    try {
        const inputItems = conversation.length
            ? conversation.map(({ role, content }) => ({ role, content }))
            : [{ role: 'user', content: question }];
        let response = await createOpenAIResponse({
            model: process.env.OPENAI_MODEL || 'gpt-5-mini', store: false,
            instructions: 'You are AgentOps AI, a read-only software-license assistant. Use a supplied tool for every factual license question. Tool outputs are authoritative aggregate metrics. Never invent facts or identifiers. Distinguish inventory capacity from potentially reclaimable seats. Never claim to modify a license. Keep answers concise.',
            input: inputItems, tools: assistantOpenAITools, tool_choice: 'required'
        });
        let recordsReviewed = 0;
        for (let round = 0; round < 3; round += 1) {
            const calls = (response.output || []).filter((item) => item.type === 'function_call' && item.name && item.call_id);
            if (calls.length === 0) {
                const answer = openAIText(response);
                if (!answer)
                    throw new Error('OpenAI returned neither an answer nor a tool call');
                return { answer, recordsReviewed, source: 'openai-mcp' };
            }
            const toolOutputs = [];
            for (const call of calls) {
                let argumentsValue = {};
                try {
                    argumentsValue = JSON.parse(call.arguments || '{}');
                }
                catch {
                    throw new Error(`OpenAI supplied invalid arguments for ${call.name}`);
                }
                const output = await callAssistantToolViaMcp(call.name, argumentsValue);
                recordsReviewed += countReviewedToolRecords(output);
                toolOutputs.push({ type: 'function_call_output', call_id: call.call_id, output });
            }
            inputItems.push(...(response.output || []), ...toolOutputs);
            response = await createOpenAIResponse({
                model: process.env.OPENAI_MODEL || 'gpt-5-mini', store: false,
                input: inputItems, tools: assistantOpenAITools, tool_choice: 'auto'
            });
        }
        throw new Error('OpenAI exceeded the assistant tool-call limit');
    }
    catch (error) {
        console.error('OpenAI MCP assistant failed; using local fallback:', getErrorMessage(error));
        return { ...(await buildFallbackAssistantAnswer(question)), source: 'monitoring-agent-fallback' };
    }
}
function startServer() {
    const app = express();
    const port = Number(process.env.PORT ?? 3002);
    const shouldUseExactPort = Boolean(process.env.PORT);
    app.use((request, response, next) => {
        const allowedOrigin = process.env.UI_ORIGIN || 'http://localhost:5173';
        const origin = request.get('origin');
        if (origin === allowedOrigin || origin === 'http://127.0.0.1:5173') {
            response.setHeader('Access-Control-Allow-Origin', origin);
            response.setHeader('Vary', 'Origin');
        }
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Id');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (request.method === 'OPTIONS') {
            response.sendStatus(204);
            return;
        }
        next();
    });
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
    app.get('/', (_request, response) => {
        sendJson(response, 200, {
            service: 'app-usage-monitor-agent',
            status: 'ok',
            intake: 'Express',
            orchestrator: 'Mastra',
            contextLayer: 'MCP Filesystem Server',
            slackCommandEndpoint: 'POST /api/slack/command'
        });
    });
    app.get('/health', (_request, response) => {
        sendJson(response, 200, { status: 'ok' });
    });
    app.get('/approval/:licenseId', (request, response) => {
        response.status(200).type('html').send(renderApprovalUi(request.params.licenseId, request));
    });
    app.post('/api/approval/:licenseId', async (request, response) => {
        const decision = request.body?.decision === 'blocked' ? 'blocked' : 'approved';
        console.log('Railway approval UI decision recorded:', {
            licenseId: request.params.licenseId,
            decision,
            ticketId: request.body?.ticketId,
            prOwner: request.body?.prOwner,
            prRepo: request.body?.prRepo,
            prNumber: request.body?.prNumber
        });
        const messages = [];
        const errors = [];
        try {
            messages.push(await updateGitHubPrFromApproval(request.body?.prOwner, request.body?.prRepo, request.body?.prNumber, decision, request.params.licenseId));
        }
        catch (error) {
            console.error('GitHub approval update failure:', error);
            errors.push(`GitHub update failed: ${getErrorMessage(error)}`);
        }
        try {
            messages.push(await updateLinearTicketFromApproval(request.body?.ticketId, decision, request.params.licenseId));
        }
        catch (error) {
            console.error('Linear approval update failure:', error);
            errors.push(`Linear update failed: ${getErrorMessage(error)}`);
        }
        if (errors.length === 0) {
            sendJson(response, 200, {
                status: 'ok',
                decision,
                message: `Allocation ${decision} for license ${request.params.licenseId}. ${messages.join(' ')}`
            });
            return;
        }
        sendJson(response, 500, {
            status: 'error',
            decision,
            message: `Decision recorded, but follow-up update failed. ${[...messages, ...errors].join(' ')}`
        });
    });
    app.post('/api/slack/command', async (request, response) => {
        const bodyData = request.rawBody ?? JSON.stringify(request.body ?? {});
        console.log('📥 [Incoming Request] Received Slash Command invocation from Slack. Raw payload:', bodyData);
        const { targetUser, targetApp } = parseSlackCommandText(request.body?.text);
        response.status(200).type('text/plain').send(`⏳ Processing license request optimization vectors for ${targetApp}...`);
        try {
            await licenseOrchestrator.execute({ targetUser, targetApp });
        }
        catch (error) {
            console.error('❌ Slack endpoint runtime failure:', error);
        }
    });
    app.post('/api/assistant/chat', async (request, response) => {
        const messages = Array.isArray(request.body?.messages)
            ? request.body.messages
                .filter((message) => {
                const item = message;
                return (item.role === 'user' || item.role === 'assistant') &&
                    typeof item.content === 'string' && item.content.trim();
            })
                .slice(-10)
                .map((message) => ({
                role: message.role,
                content: message.content.trim().slice(0, 2000)
            }))
            : [];
        const latestQuestion = [...messages]
            .reverse()
            .find((message) => message?.role === 'user' && typeof message?.content === 'string')
            ?.content.trim()
            .slice(0, 2000);
        if (!latestQuestion) {
            sendJson(response, 400, { error: 'A user message is required' });
            return;
        }
        try {
            const result = await answerAssistantQuestion(latestQuestion, messages);
            sendJson(response, 200, result);
        }
        catch (error) {
            console.error('Assistant request failed:', getErrorMessage(error));
            sendJson(response, 500, { error: 'Unable to analyze license data right now' });
        }
    });
    const listen = (targetPort) => {
        const server = app.listen(targetPort, () => {
            console.log(`License agent service listening on port ${targetPort}`);
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
async function bootstrap() {
    if (process.env.RUN_PIPELINE_ON_START === 'true') {
        try {
            await simulateSlackIntakeCommand();
        }
        catch (error) {
            console.error('Simulation run encountered an operational fault:', getErrorMessage(error));
        }
    }
    startServer();
}
bootstrap();

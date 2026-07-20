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
    branchName: z.string().nullable(),
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
function buildApprovalUiUrl(results) {
    const params = new URLSearchParams({
        user: results.targetUser,
        app: results.targetApp,
        status: results.auditStatus
    });
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
    return issueDetails?.url ? { ticketUrl: issueDetails.url } : null;
}
async function createGovernanceEvidence(results) {
    const notes = [];
    let prUrl = null;
    let branchName = null;
    let ticketUrl = null;
    const approvalUiUrl = buildApprovalUiUrl(results);
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
    return {
        ...results,
        prUrl,
        branchName,
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
          body: JSON.stringify({ decision })
        });
        const payload = await response.json();
        result.textContent = payload.message || 'Decision recorded.';
      });
    });
  </script>
</body>
</html>`;
}
function startServer() {
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
    app.post('/api/approval/:licenseId', (request, response) => {
        const decision = request.body?.decision === 'blocked' ? 'blocked' : 'approved';
        console.log('Railway approval UI decision recorded:', {
            licenseId: request.params.licenseId,
            decision
        });
        sendJson(response, 200, {
            status: 'ok',
            decision,
            message: `Allocation ${decision} for license ${request.params.licenseId}.`
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

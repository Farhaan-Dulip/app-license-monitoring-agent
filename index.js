import { Octokit } from '@octokit/rest';
import { LinearClient } from '@linear/sdk';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function requiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
function getOctokit() {
    return new Octokit({ auth: requiredEnv('GITHUB_TOKEN') });
}
function getLinearClient() {
    return new LinearClient({ apiKey: requiredEnv('LINEAR_API_KEY') });
}
function getErrorMessage(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const status = 'status' in error ? error.status : undefined;
    if (status === 401) {
        return 'GitHub rejected GITHUB_TOKEN with 401 Bad credentials. Create a fresh GitHub token, add it to Railway variables as GITHUB_TOKEN, and make sure it has access to the configured repository.';
    }
    return error.message;
}
// ---------------------------------------------------------
// NODE 1: Define the Local Database Engine via MCP Paradigm
// ---------------------------------------------------------
const analyzeLicenseDatabase = {
    id: 'analyze-license-db',
    description: 'Scans the existing license JSON configurations to locate idle users over 60 days inactive.',
    execute: async () => {
        const filePath = path.join(__dirname, 'repository-template', 'licenses.json');
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
};
function daysSince(dateValue, now = new Date()) {
    const timestamp = Date.parse(dateValue);
    if (Number.isNaN(timestamp)) {
        return 0;
    }
    return Math.floor((now.getTime() - timestamp) / (1000 * 60 * 60 * 24));
}
async function runLicenseAudit(context) {
    const database = await analyzeLicenseDatabase.execute();
    const matchingLicenses = database.licenses.filter((license) => license.application === context.targetApp);
    const reclaimableLicense = matchingLicenses.find((license) => {
        const assignedTo = license.assignedTo.toLowerCase();
        return assignedTo.includes('ex-employee') || daysSince(license.lastActiveDate) > 60;
    });
    if (!reclaimableLicense) {
        throw new Error(`No reclaimable ${context.targetApp} license was found.`);
    }
    return {
        reclaimedUser: reclaimableLicense.assignedTo,
        licenseId: reclaimableLicense.id,
        updatedLicenseArray: database.licenses.map((license) => license.id === reclaimableLicense.id
            ? { ...license, assignedTo: context.targetUser, lastActiveDate: new Date().toISOString().slice(0, 10) }
            : license)
    };
}
// ---------------------------------------------------------
// NODE 2: The Git Operator (GitHub Branching & PR Creation)
// ---------------------------------------------------------
async function executeGitHubPipeline(targetUser, updatedData) {
    const octokit = getOctokit();
    const owner = requiredEnv('GITHUB_REPO_OWNER');
    const repo = requiredEnv('GITHUB_REPO_NAME');
    const branchName = `audit/allocation-${targetUser.replace(/[^a-zA-Z0-9]/g, '-')}`;
    const { data: mainRef } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
    await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branchName}`, sha: mainRef.object.sha });
    const { data: fileData } = await octokit.repos.getContent({ owner, repo, path: 'licenses.json', ref: branchName });
    if (Array.isArray(fileData) || fileData.type !== 'file' || !fileData.sha) {
        throw new Error('Expected licenses.json to be a file in the target repository.');
    }
    await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: 'licenses.json',
        message: `[AI Governance] Reallocating idle seat to ${targetUser}`,
        content: Buffer.from(JSON.stringify(updatedData, null, 2)).toString('base64'),
        sha: fileData.sha,
        branch: branchName
    });
    const { data: pr } = await octokit.pulls.create({
        owner,
        repo,
        title: `[License Reallocation] Access Request for ${targetUser}`,
        head: branchName,
        base: 'main',
        body: `Automated data optimization pipeline executed. Reallocated idle seat to ${targetUser}.`
    });
    return { prUrl: pr.html_url, branchName };
}
// ---------------------------------------------------------
// NODE 3: The Governance Tracker (Linear Log Provisioning)
// ---------------------------------------------------------
async function createLinearAuditTicket(targetUser, prUrl) {
    const linear = getLinearClient();
    const teams = await linear.teams();
    const targetTeam = teams.nodes[0];
    if (!targetTeam) {
        throw new Error('No Linear team was found for the configured API key.');
    }
    const issue = await linear.createIssue({
        teamId: targetTeam.id,
        title: `[Audit Compliance] License Provision Verification for ${targetUser}`,
        description: `A JIT software allocation has been staged via GitOps controls.\nReview active repository changes here: ${prUrl}\n\nStatus: Awaiting Management Slack clearance authorization key.`,
        priority: 1
    });
    const issueDetails = await issue.issue;
    return { ticketUrl: issueDetails?.url };
}
// ---------------------------------------------------------
// NODE 4: Multi-Step Orchestration State Machine
// ---------------------------------------------------------
export const licenseOrchestrator = {
    name: 'LicenseOptimizationFlow',
    async execute(context) {
        const runAIAudit = { auditResults: await runLicenseAudit(context) };
        const triggerGitOps = await executeGitHubPipeline(context.targetUser, {
            licenses: runAIAudit.auditResults.updatedLicenseArray
        });
        const logGovernanceTicket = await createLinearAuditTicket(context.targetUser, triggerGitOps.prUrl);
        return {
            steps: {
                runAIAudit,
                triggerGitOps,
                logGovernanceTicket
            }
        };
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
    // ---------------------------------------------------------
    // NODE 5: Centralized Slack Notification Block Component
    // ---------------------------------------------------------
    console.log('\n=======================================================');
    console.log('CHATOPS INTERACTIVE CONTROL CARD GENERATED SUCCESSFULLY');
    console.log('=======================================================');
    console.log(`Target User Assignment:  ${executionContext.targetUser}`);
    console.log(`Application Component:   ${executionContext.targetApp}`);
    console.log(`Git Audit Pull Request:  ${runtimeResults.steps.triggerGitOps.prUrl}`);
    console.log(`Linear Compliance Log:   ${runtimeResults.steps.logGovernanceTicket.ticketUrl}`);
    const repo = requiredEnv('GITHUB_REPO_NAME');
    const branch = runtimeResults.steps.triggerGitOps.branchName.replace(/\//g, '-');
    console.log(`Ephemeral Railway Portal: https://${repo}-${branch}.up.railway.app`);
    console.log('=======================================================\n');
    console.log('[ AUTHORIZE MERGE & PROVISION ]    [ BLOCK TRANSITION ]');
}
function sendJson(response, statusCode, body) {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body, null, 2));
}
function startServer() {
    const port = Number(process.env.PORT ?? 3000);
    const server = http.createServer(async (request, response) => {
        if (request.method === 'GET' && request.url === '/') {
            sendJson(response, 200, {
                service: 'app-usage-monitor-agent',
                status: 'ok',
                runPipeline: 'POST /run'
            });
            return;
        }
        if (request.method === 'GET' && request.url === '/health') {
            sendJson(response, 200, { status: 'ok' });
            return;
        }
        if (request.method === 'POST' && request.url === '/run') {
            try {
                const executionContext = {
                    targetUser: process.env.TARGET_USER ?? 'Amila@company.com',
                    targetApp: process.env.TARGET_APP ?? 'MuleSoft Anypoint'
                };
                const result = await licenseOrchestrator.execute(executionContext);
                sendJson(response, 200, { status: 'completed', result });
            }
            catch (error) {
                sendJson(response, 500, { status: 'failed', error: getErrorMessage(error) });
            }
            return;
        }
        sendJson(response, 404, { status: 'not_found' });
    });
    server.listen(port, () => {
        console.log(`License agent service listening on port ${port}`);
    });
}
if (process.env.RUN_PIPELINE_ON_START === 'true') {
    simulateSlackIntakeCommand().catch((error) => {
        console.error(getErrorMessage(error));
        startServer();
    });
}
else {
    startServer();
}

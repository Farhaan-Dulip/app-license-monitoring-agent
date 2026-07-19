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
        return 'GitHub rejected GITHUB_TOKEN with 401 Bad credentials.';
    }
    return error.message;
}
// Helper to parse URL-encoded bodies sent by Slack commands
function parseFormBody(bodyStr) {
    const params = {};
    const pairs = bodyStr.split('&');
    for (const pair of pairs) {
        const [key, val] = pair.split('=');
        if (key) {
            params[decodeURIComponent(key)] = decodeURIComponent(val || '').replace(/\+/g, ' ');
        }
    }
    return params;
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
    const { data: mainRef } = await octokit.git.getRef({ owner, repo, ref: 'heads/develop' });
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
// -----------------------------------------------------------------------
// NODE 5: Outgoing Slack Messenger (Dispatches Block Kit UI Elements)
// -----------------------------------------------------------------------
async function dispatchSlackInteractiveCard(user, appName, pr, ticket, preview) {
    const webhookUrl = requiredEnv('SLACK_WEBHOOK_URL');
    const slackPayload = {
        blocks: [
            {
                type: "header",
                text: { type: "plain_text", text: "🔐 AccessGuard Enterprise License Audit" }
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Target Assignment:* \`${user}\`\n*Requested Platform:* *${appName}*\n*Compliance Status:* 🟢 Found Inactive Profile. Reallocating existing token.\n*Financial Footprint:* *Net $0 Variance (Saved $120/mo)* 💸`
                }
            },
            {
                type: "divider"
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `📂 *Source Control Log:* <${pr}|Review GitHub Pull Request>\n🎫 *Governance tracking:* <${ticket}|View Linear Issue Ticket>\n🚀 *Staging Preview Portal:* <${preview}|Open Ephemeral Staging Hub>`
                }
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        style: "primary",
                        text: { type: "plain_text", text: "🟢 Approve Allocation" },
                        value: "approve_allocation"
                    },
                    {
                        type: "button",
                        style: "danger",
                        text: { type: "plain_text", text: "🔴 Block Provision" },
                        value: "block_provision"
                    }
                ]
            }
        ]
    };
    return new Promise((resolve, reject) => {
        const url = new URL(webhookUrl);
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };
        const req = http.request(options, (res) => {
            res.on('data', () => { });
            res.on('end', () => resolve());
        });
        req.on('error', (err) => reject(err));
        req.write(JSON.stringify(slackPayload));
        req.end();
    });
}
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
    const repo = requiredEnv('GITHUB_REPO_NAME');
    const branch = runtimeResults.steps.triggerGitOps.branchName.replace(/\//g, '-');
    const previewUrl = `https://${repo}-${branch}.up.railway.app`;
    try {
        await dispatchSlackInteractiveCard(executionContext.targetUser, executionContext.targetApp, runtimeResults.steps.triggerGitOps.prUrl, runtimeResults.steps.logGovernanceTicket.ticketUrl || '', previewUrl);
        console.log('Status: Interactive layout dashboard card successfully pushed to Slack!');
    }
    catch (err) {
        console.warn('Status: Pipeline passed but target Slack Webhook rejected dispatch payload.', getErrorMessage(err));
    }
}
function sendJson(response, statusCode, body) {
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body, null, 2));
}
function startServer() {
    const port = Number(process.env.PORT ?? 3000);
    const shouldUseExactPort = Boolean(process.env.PORT);
    const server = http.createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/') {
            sendJson(response, 200, {
                service: 'app-usage-monitor-agent',
                status: 'ok',
                slackCommandEndpoint: 'POST /api/slack/command'
            });
            return;
        }
        if (request.method === 'GET' && request.url === '/health') {
            sendJson(response, 200, { status: 'ok' });
            return;
        }
        if (request.method === 'POST' && request.url === '/api/slack/command') {
            let bodyData = '';
            request.on('data', (chunk) => {
                bodyData += chunk.toString();
            });
            request.on('end', async () => {
                try {
                    const parsedForm = parseFormBody(bodyData);
                    const slackInputText = parsedForm.text || '';
                    const spaceIndex = slackInputText.indexOf(' ');
                    let targetUser = 'Amila@company.com';
                    let targetApp = 'MuleSoft Anypoint';
                    if (spaceIndex !== -1) {
                        targetUser = slackInputText.substring(0, spaceIndex).trim();
                        targetApp = slackInputText.substring(spaceIndex + 1).trim();
                    }
                    response.writeHead(200, { 'content-type': 'text/plain' });
                    response.end(`⏳ Processing license request optimization vectors for ${targetApp}...`);
                    const results = await licenseOrchestrator.execute({ targetUser, targetApp });
                    const repo = requiredEnv('GITHUB_REPO_NAME');
                    const branch = results.steps.triggerGitOps.branchName.replace(/\//g, '-');
                    const previewUrl = `https://${repo}-${branch}.up.railway.app`;
                    await dispatchSlackInteractiveCard(targetUser, targetApp, results.steps.triggerGitOps.prUrl, results.steps.logGovernanceTicket.ticketUrl || '', previewUrl);
                }
                catch (error) {
                    console.error("Async Workflow Execution Interrupted:", getErrorMessage(error));
                }
            });
            return;
        }
        sendJson(response, 404, { status: 'not_found' });
    });
    const listen = (targetPort) => {
        // Clear out stale listeners before binding a fresh port attempt
        server.removeAllListeners('error');
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE' && !shouldUseExactPort) {
                console.warn(`Port ${targetPort} is already in use. Trying ${targetPort + 1}...`);
                setTimeout(() => listen(targetPort + 1), 10);
                return;
            }
            console.error(error.message);
            process.exitCode = 1;
        });
        server.listen(targetPort, () => {
            console.log(`License agent service listening on port ${targetPort}`);
        });
    };
    listen(port);
}
// ---------------------------------------------------------
// REFACTORED PROCESS INITIALIZATION BOOTSTRAPPER
// ---------------------------------------------------------
async function bootstrap() {
    if (process.env.RUN_PIPELINE_ON_START === 'true') {
        try {
            await simulateSlackIntakeCommand();
        }
        catch (error) {
            console.error("Simulation run encountered an operational fault:", getErrorMessage(error));
        }
    }
    // Safely activate the HTTP web server exactly once
    startServer();
}
bootstrap();

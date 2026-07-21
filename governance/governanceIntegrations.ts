import * as fs from 'node:fs';
import type { LinearClient } from '@linear/sdk';
import type { Octokit } from '@octokit/rest';
import { getLinearClient, getOctokit } from '../clients/clients.js';
import {
  delay,
  getErrorMessage,
  optionalEnv,
  resolveGeneratedArtifactPath
} from '../runtime/runtime.js';
import type { ExecutionContext, MutationResults } from '../types/types.js';

// Creates or updates one file on the workflow branch, supporting both existing and brand-new generated artifacts.
async function upsertGitHubFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  branchName: string,
  filePath: string,
  content: string,
  message: string
): Promise<void> {
  const normalizedPath = filePath.replace(/\\/g, '/');
  let sha: string | undefined;

  try {
    const { data: fileData } = await octokit.repos.getContent({
      owner,
      repo,
      path: normalizedPath,
      ref: branchName
    });

    if (!Array.isArray(fileData) && fileData.type === 'file') {
      sha = fileData.sha;
    }
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'status' in error && error.status === 404)) {
      throw error;
    }
  }

  const requestParameters = {
    owner,
    repo,
    path: normalizedPath,
    message,
    content: Buffer.from(content).toString('base64'),
    branch: branchName
  };

  await octokit.repos.createOrUpdateFileContents(
    sha ? { ...requestParameters, sha } : requestParameters
  );
}

// Creates a GitHub branch from the configured base branch so generated artifacts can be committed before PR review.
export async function createGitHubEvidenceBranch(requester: string): Promise<{ branchName: string; prOwner: string; prRepo: string } | null> {
  const octokit = getOctokit();
  const owner = optionalEnv('GITHUB_REPO_OWNER');
  const repo = optionalEnv('GITHUB_REPO_NAME');
  const baseBranch = optionalEnv('GITHUB_BASE_BRANCH') ?? 'develop';

  if (!octokit || !owner || !repo) {
    return null;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const branchName = `delivery/request-${requester.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;

  const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });

  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha
    });
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'status' in error && error.status === 422)) {
      throw error;
    }
  }

  return {
    branchName,
    prOwner: owner,
    prRepo: repo
  };
}

// Resolves LINEAR_TEAM_ID from UUID, key, or team name, with fallback to the first available team.
async function resolveLinearTeamId(linear: LinearClient): Promise<string> {
  const configuredTeamId = optionalEnv('LINEAR_TEAM_ID');
  let teamId = configuredTeamId;

  if (teamId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(teamId)) {
    const teams = await linear.teams();
    const matchingTeam = teams.nodes.find(
      (team) =>
        team.key.toLowerCase() === teamId?.toLowerCase() ||
        team.name.toLowerCase() === teamId?.toLowerCase()
    );

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

  return teamId;
}

// Creates a Linear intake ticket immediately after Slack command processing starts.
async function createLinearIntakeTicket(context: ExecutionContext): Promise<{ ticketId: string; ticketUrl: string } | null> {
  const linear = getLinearClient();
  if (!linear) {
    return null;
  }

  const teamId = await resolveLinearTeamId(linear);

  const issue = await linear.createIssue({
    teamId,
    title: `[Intake] AI delivery request for ${context.requester}`,
    description: [
      'Intake ticket created before branch/design/PR generation.',
      '',
      `Requester: ${context.requester}`,
      `Requested work: ${context.requestedWork}`,
      '',
      'This ticket will be updated/closed when PR review passes and merge completes.'
    ].join('\n'),
    priority: 1
  });

  const issueDetails = await issue.issue;
  return issueDetails?.url ? { ticketId: issueDetails.id, ticketUrl: issueDetails.url } : null;
}

// Provisions governance artifacts early in the flow: first ticket, then branch.
export async function provisionGovernanceIntake(context: ExecutionContext): Promise<ExecutionContext> {
  const notes: string[] = [...(context.governanceNotes ?? [])];
  let ticketId = context.ticketId ?? null;
  let ticketUrl = context.ticketUrl ?? null;
  let branchName = context.branchName ?? null;
  let prOwner = context.prOwner ?? null;
  let prRepo = context.prRepo ?? null;

  try {
    if (!ticketId) {
      const ticket = await createLinearIntakeTicket(context);
      if (ticket) {
        ticketId = ticket.ticketId;
        ticketUrl = ticket.ticketUrl;
        notes.push('Linear intake ticket created.');
      } else {
        notes.push('Linear intake skipped: missing LINEAR_API_KEY.');
      }
    }
  } catch (error: unknown) {
    notes.push(`Linear intake failed: ${getErrorMessage(error)}`);
  }

  try {
    if (!branchName) {
      const branch = await createGitHubEvidenceBranch(context.requester);
      if (branch) {
        branchName = branch.branchName;
        prOwner = branch.prOwner;
        prRepo = branch.prRepo;
        notes.push('GitHub branch created from develop/base branch.');
      } else {
        notes.push('GitHub branch creation skipped: missing GitHub configuration.');
      }
    }
  } catch (error: unknown) {
    notes.push(`GitHub branch creation failed: ${getErrorMessage(error)}`);
  }

  return {
    ...context,
    ticketId,
    ticketUrl,
    branchName,
    prOwner,
    prRepo,
    governanceNotes: notes
  };
}

// Commits current database + generated artifacts to the existing governance branch.
export async function syncEvidenceToGitHubBranch(
  results: MutationResults,
  owner: string,
  repo: string,
  branchName: string
): Promise<void> {
  const octokit = getOctokit();
  if (!octokit) {
    throw new Error('GITHUB_TOKEN is not configured; cannot sync branch evidence.');
  }

  const updatedData = {
    organization: results.database.organization,
    lastUpdated: results.database.lastUpdated,
    requests: results.updatedRequestArray
  };

  await upsertGitHubFile(
    octokit,
    owner,
    repo,
    branchName,
    'delivery-requests.json',
    `${JSON.stringify(updatedData, null, 2)}\n`,
    `[Governance] Track AI delivery request for ${results.requester}`
  );

  const generatedFileMap = new Map(
    results.reactGeneration.generatedFiles.map((file) => [file.path.replace(/\\/g, '/'), file.content])
  );

  const localArtifactPaths = new Set([
    results.figmaDesign.designSpecPath,
    results.figmaDesign.pluginPayloadPath,
    ...results.reactGeneration.generatedFiles.map((file) => file.path),
    ...(results.updatedRequestArray.find((record) => record.id === results.requestId)?.generatedFiles ?? [])
  ]);

  for (const artifactPath of localArtifactPaths) {
    const normalizedPath = artifactPath.replace(/\\/g, '/');
    const generatedContent = generatedFileMap.get(normalizedPath);
    const content = generatedContent ?? (() => {
      const absoluteArtifactPath = resolveGeneratedArtifactPath(normalizedPath);
      if (!fs.existsSync(absoluteArtifactPath)) {
        return null;
      }
      return fs.readFileSync(absoluteArtifactPath, 'utf-8');
    })();

    if (!content) {
      console.warn(`Skipping missing generated artifact for GitHub PR: ${artifactPath}`);
      continue;
    }

    await upsertGitHubFile(
      octokit,
      owner,
      repo,
      branchName,
      normalizedPath,
      content,
      `[Generated Artifact] Add ${artifactPath} for ${results.requestId}`
    );
  }
}

// Creates a PR if one does not exist yet for this branch; otherwise returns the existing open PR.
export async function ensureEvidencePullRequest(
  results: MutationResults,
  owner: string,
  repo: string,
  branchName: string
): Promise<{ prUrl: string; prNumber: number }> {
  const octokit = getOctokit();
  if (!octokit) {
    throw new Error('GITHUB_TOKEN is not configured; cannot create PR evidence.');
  }

  const baseBranch = optionalEnv('GITHUB_BASE_BRANCH') ?? 'develop';
  const { data: existing } = await octokit.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${branchName}`,
    base: baseBranch
  });

  if (existing.length > 0) {
    const existingPr = existing[0];
    if (!existingPr) {
      throw new Error('GitHub returned an empty pull request list unexpectedly.');
    }
    return {
      prUrl: existingPr.html_url,
      prNumber: existingPr.number
    };
  }

  const { data: pullRequest } = await octokit.pulls.create({
    owner,
    repo,
    title: `[AI Delivery Request] ${results.requestedWork}`,
    head: branchName,
    base: baseBranch,
    body: [
      'Automated governance evidence for Slack-triggered AI engineering delivery workflow.',
      '',
      `- Requester: ${results.requester}`,
      `- Requested work: ${results.requestedWork}`,
      `- Request ID: ${results.requestId}`,
      `- Figma design spec: ${results.figmaDesign.designSpecPath}`,
      `- Figma plugin payload: ${results.figmaDesign.pluginPayloadPath}`,
      `- React component: ${results.reactGeneration.componentName}`,
      `- Overall quality score: ${results.uiQualityReview?.score ?? 'not reviewed'}`,
      `- Generated files: ${results.reactGeneration.generatedFiles.map((file) => file.path).join(', ')}`
    ].join('\n')
  });

  return {
    prUrl: pullRequest.html_url,
    prNumber: pullRequest.number
  };
}

// Posts review status comments to the generated evidence PR.
export async function postGitHubPrReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  title: string,
  bodyLines: string[]
): Promise<void> {
  const octokit = getOctokit();
  if (!octokit) {
    return;
  }

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: [
      `### ${title}`,
      ...bodyLines
    ].join('\n')
  });
}

// Moves the linked Linear ticket to Done after the generated PR has merged.
export async function closeLinearTicketAfterMerge(
  ticketId: string | undefined,
  requestId: string
): Promise<string> {
  if (!ticketId) {
    return 'Linear ticket was not linked to this delivery request.';
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
  const targetState = states.nodes.find((state) => state.type === 'completed')
    ?? states.nodes.find((state) => ['done', 'completed', 'complete'].includes(state.name.toLowerCase()));

  if (!targetState) {
    throw new Error(`Could not find a Linear completed workflow state for team ${team.name}.`);
  }

  await linear.updateIssue(ticketId, { stateId: targetState.id });
  await linear.createComment({
    issueId: ticketId,
    body: `GitHub PR merged and Railway deployment completed for AI delivery request \`${requestId}\`.`
  });

  return `Linear ticket moved to ${targetState.name}.`;
}

// Waits until GitHub has calculated whether a PR can be merged.
async function waitForGitHubPullRequestMergeable(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string> {
  const maxChecks = Math.max(1, Number(optionalEnv('GITHUB_MERGEABLE_MAX_CHECKS') ?? '8'));
  const delayMs = Math.max(250, Number(optionalEnv('GITHUB_MERGEABLE_DELAY_MS') ?? '1500'));
  let lastState = 'unknown';

  for (let attempt = 1; attempt <= maxChecks; attempt += 1) {
    const { data: pullRequest } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber
    });
    const mergeableState = typeof pullRequest.mergeable_state === 'string'
      ? pullRequest.mergeable_state
      : 'unknown';
    lastState = mergeableState;

    if (pullRequest.mergeable === true && !['dirty', 'blocked', 'unknown'].includes(mergeableState)) {
      return mergeableState;
    }

    if (pullRequest.mergeable === false || ['dirty', 'blocked'].includes(mergeableState)) {
      throw new Error(`GitHub PR #${pullNumber} is not mergeable yet. mergeable=${pullRequest.mergeable}, mergeable_state=${mergeableState}.`);
    }

    await delay(delayMs);
  }

  throw new Error(`GitHub PR #${pullNumber} mergeability stayed ${lastState} after ${maxChecks} check(s).`);
}

// Merges the generated GitHub PR after the review agent passes the delivery.
export async function mergeGitHubPrAfterReview(
  prOwner: string | undefined,
  prRepo: string | undefined,
  prNumberValue: string | number | undefined,
  requestId: string
): Promise<string> {
  if (!prOwner || !prRepo || !prNumberValue) {
    return 'GitHub PR was not linked to this delivery request.';
  }

  const octokit = getOctokit();
  if (!octokit) {
    return 'GITHUB_TOKEN is not configured; GitHub PR was not updated.';
  }

  const pull_number = Number(prNumberValue);
  if (!Number.isInteger(pull_number) || pull_number <= 0) {
    throw new Error(`Invalid GitHub PR number: ${prNumberValue}`);
  }

  const mergeableState = await waitForGitHubPullRequestMergeable(octokit, prOwner, prRepo, pull_number);
  await octokit.pulls.merge({
    owner: prOwner,
    repo: prRepo,
    pull_number,
    merge_method: 'squash',
    commit_title: `[Governance Approved] Merge AI delivery request ${requestId}`
  });

  return `GitHub PR #${pull_number} merged after mergeability state ${mergeableState}.`;
}

import { LinearClient } from '@linear/sdk';
import { Octokit } from '@octokit/rest';
import { optionalEnv } from '../services/runtime/runtime.js';

// Creates a GitHub API client when GITHUB_TOKEN is configured, otherwise disables GitHub governance.
export function getOctokit(): Octokit | undefined {
  const token = optionalEnv('GITHUB_TOKEN');
  return token ? new Octokit({ auth: token }) : undefined;
}

// Creates a Linear API client when LINEAR_API_KEY is configured, otherwise disables Linear governance.
export function getLinearClient(): LinearClient | undefined {
  const apiKey = optionalEnv('LINEAR_API_KEY');
  return apiKey ? new LinearClient({ apiKey }) : undefined;
}

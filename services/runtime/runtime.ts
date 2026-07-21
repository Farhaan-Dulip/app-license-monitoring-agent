import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MutationResults } from '../../types/types.js';

const __filename = fileURLToPath(import.meta.url);
const __moduleDirname = path.dirname(__filename);
const PROJECT_ROOT = path.dirname(path.dirname(__moduleDirname));

export const DELIVERY_DATABASE_PATH = path.join(PROJECT_ROOT, 'delivery-requests.json');
export const GENERATED_APP_DIR = path.join(PROJECT_ROOT, 'generated-app');
export const GENERATED_DOCS_DIR = path.join(PROJECT_ROOT, 'docs');
export const GENERATED_FIGMA_DIR = path.join(PROJECT_ROOT, 'generated-artifacts', 'figma');
export const FIGMA_PLUGIN_DIR = path.join(PROJECT_ROOT, 'services', 'figma-plugin');

// Reads a required environment variable and stops startup/workflow execution when the value is missing.
export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Reads an optional environment variable and normalizes empty strings to undefined.
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

// Converts any thrown value into a readable string for logs, Slack notes, and API responses.
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Waits between external API polling attempts.
export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// Creates an absolute path for generated artifacts and prevents MCP writes from escaping approved folders.
export function resolveGeneratedArtifactPath(relativePath: string): string {
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const absolutePath = path.resolve(PROJECT_ROOT, normalizedPath);
  const allowedRoots = [GENERATED_APP_DIR, GENERATED_DOCS_DIR, GENERATED_FIGMA_DIR, FIGMA_PLUGIN_DIR].map((root) => path.resolve(root));

  if (!allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))) {
    throw new Error(`Generated artifact path is outside approved directories: ${relativePath}`);
  }

  return absolutePath;
}

// Resolves the public base URL used in Slack links, preferring explicit app/Railway env vars before localhost.
export function getPublicBaseUrl(): string {
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

// Builds the Railway-hosted URL for the generated UI output created from the Slack prompt.
export function buildGeneratedUiUrl(results: MutationResults): string {
  return `${getPublicBaseUrl()}/generated/${encodeURIComponent(results.requestId)}`;
}

// Calculates how many days have passed since a delivery record was last updated so stale requests can be reused.
export function daysSince(dateValue: string, now = new Date()): number {
  const timestamp = Date.parse(dateValue);
  if (Number.isNaN(timestamp)) {
    return 0;
  }
  return Math.floor((now.getTime() - timestamp) / (1000 * 60 * 60 * 24));
}

// Creates URL/file safe identifiers for generated branches, files, and component names.
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'generated-ui';
}

// Escapes user-controlled values before rendering workflow data into HTML responses.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

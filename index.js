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
const DELIVERY_DATABASE_PATH = path.join(__dirname, 'delivery-requests.json');
const GENERATED_APP_DIR = path.join(__dirname, 'generated-app');
const GENERATED_DOCS_DIR = path.join(__dirname, 'docs');
const FIGMA_AGENT_DIR = path.join(__dirname, 'figma-agent');
const FIGMA_PLUGIN_DIR = path.join(__dirname, 'figma-plugin');
const deliveryRecordSchema = z.object({
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
    generatedFiles: z.array(z.string()).optional()
});
const generatedFileSchema = z.object({
    path: z.string(),
    content: z.string()
});
const designBriefSchema = z.object({
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
const figmaDesignArtifactSchema = z.object({
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
const reactGenerationResultSchema = z.object({
    summary: z.string(),
    componentName: z.string(),
    previewHtml: z.string(),
    generatedFiles: z.array(generatedFileSchema)
});
const deliveryDatabaseSchema = z.object({
    organization: z.string().optional(),
    lastUpdated: z.string().optional(),
    requests: z.array(deliveryRecordSchema)
});
const executionContextSchema = z.object({
    requester: z.string().min(1),
    requestedWork: z.string().min(1)
});
const designBriefResultsSchema = executionContextSchema.extend({
    designBrief: designBriefSchema
});
const figmaDesignResultsSchema = designBriefResultsSchema.extend({
    figmaDesign: figmaDesignArtifactSchema
});
const reactGenerationResultsSchema = figmaDesignResultsSchema.extend({
    reactGeneration: reactGenerationResultSchema
});
const analysisResultsSchema = reactGenerationResultsSchema.extend({
    previousOwner: z.string(),
    requestId: z.string(),
    analysisStatus: z.enum(['updated_existing', 'new_request']),
    updatedRequestArray: z.array(deliveryRecordSchema),
    database: deliveryDatabaseSchema
});
const mutationResultsSchema = analysisResultsSchema.extend({
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
    generatedUiUrl: z.string(),
    governanceStatus: z.enum(['created', 'skipped', 'partial']),
    governanceNotes: z.array(z.string())
});
const workflowResultsSchema = z.object({
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
    approvalUiUrl: z.string(),
    generatedUiUrl: z.string(),
    governanceStatus: z.enum(['created', 'skipped', 'partial']),
    governanceNotes: z.array(z.string()),
    slackDispatched: z.boolean()
});
// Reads a required environment variable and stops startup/workflow execution when the value is missing.
function requiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
// Reads an optional environment variable and normalizes empty strings to undefined.
function optionalEnv(name) {
    const value = process.env[name];
    return value && value.trim() ? value : undefined;
}
// Converts any thrown value into a readable string for logs, Slack notes, and API responses.
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// Creates a GitHub API client when GITHUB_TOKEN is configured, otherwise disables GitHub governance.
function getOctokit() {
    const token = optionalEnv('GITHUB_TOKEN');
    return token ? new Octokit({ auth: token }) : undefined;
}
// Creates a Linear API client when LINEAR_API_KEY is configured, otherwise disables Linear governance.
function getLinearClient() {
    const apiKey = optionalEnv('LINEAR_API_KEY');
    return apiKey ? new LinearClient({ apiKey }) : undefined;
}
// Creates an absolute path for generated artifacts and prevents MCP writes from escaping approved folders.
function resolveGeneratedArtifactPath(relativePath) {
    const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absolutePath = path.resolve(__dirname, normalizedPath);
    const allowedRoots = [GENERATED_APP_DIR, GENERATED_DOCS_DIR, FIGMA_AGENT_DIR, FIGMA_PLUGIN_DIR].map((root) => path.resolve(root));
    if (!allowedRoots.some((root) => absolutePath === root || absolutePath.startsWith(`${root}${path.sep}`))) {
        throw new Error(`Generated artifact path is outside approved directories: ${relativePath}`);
    }
    return absolutePath;
}
// Resolves the public base URL used in Slack links, preferring explicit app/Railway env vars before localhost.
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
// Builds the Railway approval portal URL and embeds request metadata, Linear ticket ID, and GitHub PR metadata.
function buildApprovalUiUrl(results, ticketId, githubPr) {
    const params = new URLSearchParams({
        requester: results.requester,
        work: results.requestedWork,
        status: results.analysisStatus
    });
    if (ticketId) {
        params.set('ticketId', ticketId);
    }
    if (githubPr) {
        params.set('prNumber', String(githubPr.prNumber));
        params.set('prOwner', githubPr.prOwner);
        params.set('prRepo', githubPr.prRepo);
    }
    return `${getPublicBaseUrl()}/approval/${encodeURIComponent(results.requestId)}?${params.toString()}`;
}
// Builds the Railway-hosted URL for the generated UI output created from the Slack prompt.
function buildGeneratedUiUrl(results) {
    return `${getPublicBaseUrl()}/generated/${encodeURIComponent(results.requestId)}`;
}
// Creates a Vite middleware server for the generated React app so previews use App.jsx and App.css.
async function createGeneratedAppViteServer() {
    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    return createServer({
        root: GENERATED_APP_DIR,
        appType: 'custom',
        logLevel: 'error',
        plugins: [react()],
        server: {
            middlewareMode: true,
            allowedHosts: true,
            hmr: false
        }
    });
}
// Calculates how many days have passed since a delivery record was last updated so stale requests can be reused.
function daysSince(dateValue, now = new Date()) {
    const timestamp = Date.parse(dateValue);
    if (Number.isNaN(timestamp)) {
        return 0;
    }
    return Math.floor((now.getTime() - timestamp) / (1000 * 60 * 60 * 24));
}
// Creates URL/file safe identifiers for generated branches, files, and component names.
function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'generated-ui';
}
// Extracts plain text from OpenAI Chat Completions JSON mode responses.
function extractChatCompletionText(payload) {
    const parsedPayload = z.object({
        choices: z.array(z.object({
            message: z.object({
                content: z.string().nullable()
            })
        }))
    }).parse(payload);
    const content = parsedPayload.choices[0]?.message.content;
    if (!content) {
        throw new Error('OpenAI response did not contain text content.');
    }
    return content;
}
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
// Calls OpenAI for steps that must be truly agentic and should fail instead of using a deterministic template.
async function callOpenAiJsonStrict(prompt, schema) {
    return schema.parse(await callOpenAiJsonStrictRaw(prompt));
}
// Calls OpenAI and returns raw JSON so the caller can normalize common model shape drift before validation.
async function callOpenAiJsonStrictRaw(prompt) {
    const apiKey = requiredEnv('OPENAI_API_KEY');
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
                    content: 'You are an autonomous senior React product designer and frontend engineer. Generate polished, production-quality UI, not default HTML. Return valid JSON only. Do not include markdown fences.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ]
        })
    });
    if (!response.ok) {
        throw new Error(`OpenAI React code generation failed with ${response.status}: ${await response.text()}`);
    }
    return JSON.parse(extractChatCompletionText(await response.json()));
}
// Produces a reliable local design brief for the restaurant landing-page demo when the LLM is unavailable.
function fallbackDesignBrief(requestedWork) {
    return {
        pageType: 'restaurant landing page',
        brandName: 'Ember & Sage',
        audience: 'local diners looking for a polished dinner reservation experience',
        mood: 'warm, refined, appetizing, modern',
        colorPalette: ['#101820', '#f7efe2', '#c94f3d', '#d7a86e', '#355e4b'],
        typography: 'Elegant serif display headings with clean sans-serif body text',
        sections: ['Navigation', 'Hero reservation CTA', 'Signature dishes', 'Chef story', 'Private dining CTA', 'Footer'],
        primaryCta: 'Reserve a Table',
        acceptanceCriteria: [
            'Responsive restaurant landing page renders on mobile and desktop',
            'Hero section includes brand name, cuisine positioning, and reservation CTA',
            'Menu preview shows at least three featured dishes',
            'Final page includes GitHub, Linear, Railway, and Figma traceability'
        ],
        implementationPlan: [
            'Create a Figma-ready frame specification for the landing page',
            'Generate React component structure from the design spec',
            'Write CSS for responsive layout, palette, spacing, and cards',
            'Commit generated artifacts and delivery metadata through GitHub governance'
        ],
        riskLevel: 'low'
    };
}
// Converts flexible LLM brief output into the strict internal DesignBrief contract used by downstream agents.
function valueToText(value, fallback) {
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    if (Array.isArray(value)) {
        const joined = value.map((item) => valueToText(item, '')).filter(Boolean).join(', ');
        return joined || fallback;
    }
    if (value && typeof value === 'object') {
        const record = value;
        const preferredValue = record.value ?? record.name ?? record.label ?? record.title ?? record.text ?? record.description;
        if (preferredValue !== undefined) {
            return valueToText(preferredValue, fallback);
        }
        const flattened = Object.entries(record)
            .map(([key, item]) => `${key}: ${valueToText(item, '')}`)
            .filter((item) => !item.endsWith(': '))
            .join(', ');
        return flattened || fallback;
    }
    return fallback;
}
// Converts flexible LLM arrays/objects into a plain string array.
function valueToTextArray(value, fallback) {
    if (Array.isArray(value)) {
        const normalized = value.map((item) => valueToText(item, '')).filter(Boolean);
        return normalized.length > 0 ? normalized : fallback;
    }
    if (value && typeof value === 'object') {
        const normalized = Object.values(value).map((item) => valueToText(item, '')).filter(Boolean);
        return normalized.length > 0 ? normalized : fallback;
    }
    if (typeof value === 'string' && value.trim()) {
        return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
    }
    return fallback;
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
        'Return JSON for a landing-page design brief.',
        `Slack requester: ${context.requester}`,
        `Slack prompt: ${context.requestedWork}`,
        'The user wants the Figma agent to create the design first, then convert that design to React.',
        'Required JSON keys: pageType, brandName, audience, mood, colorPalette, typography, sections, primaryCta, acceptanceCriteria, implementationPlan, riskLevel.',
        'Important: colorPalette must be an array of hex color strings.',
        'Important: typography, primaryCta, and every sections item must be plain strings.',
        'Important: riskLevel must be exactly one of: low, medium, high.',
        'Use realistic restaurant landing-page content if the prompt is vague.'
    ].join('\n');
    const rawBrief = await callOpenAiJson(prompt, z.unknown(), fallbackDesignBrief(context.requestedWork));
    return {
        ...context,
        designBrief: normalizeDesignBrief(rawBrief, context.requestedWork)
    };
}
// Builds the Figma plugin code that can materialize the generated design brief into real Figma nodes.
function buildFigmaPluginCode(brief) {
    const sectionData = JSON.stringify(brief.sections, null, 2);
    const palette = JSON.stringify(brief.colorPalette, null, 2);
    return `const sections = ${sectionData};
const palette = ${palette};

async function main() {
  const frame = figma.createFrame();
  frame.name = ${JSON.stringify(brief.brandName)} + ' - Restaurant Landing Page';
  frame.resize(1440, 2200);
  frame.fills = [{ type: 'SOLID', color: hexToRgb(palette[1] || '#f7efe2') }];
  frame.layoutMode = 'VERTICAL';
  frame.itemSpacing = 32;
  frame.paddingTop = 64;
  frame.paddingRight = 80;
  frame.paddingBottom = 64;
  frame.paddingLeft = 80;

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });

  const title = figma.createText();
  title.name = 'Hero title';
  title.fontName = { family: 'Inter', style: 'Bold' };
  title.fontSize = 72;
  title.characters = ${JSON.stringify(brief.brandName)};
  title.fills = [{ type: 'SOLID', color: hexToRgb(palette[0] || '#101820') }];
  frame.appendChild(title);

  const subtitle = figma.createText();
  subtitle.name = 'Hero subtitle';
  subtitle.fontName = { family: 'Inter', style: 'Regular' };
  subtitle.fontSize = 28;
  subtitle.characters = ${JSON.stringify(brief.mood)};
  subtitle.fills = [{ type: 'SOLID', color: hexToRgb(palette[4] || '#355e4b') }];
  frame.appendChild(subtitle);

  for (const sectionName of sections) {
    const section = figma.createFrame();
    section.name = sectionName;
    section.resize(1280, 220);
    section.fills = [{ type: 'SOLID', color: hexToRgb('#ffffff') }];
    section.cornerRadius = 24;
    section.paddingTop = 32;
    section.paddingRight = 32;
    section.paddingBottom = 32;
    section.paddingLeft = 32;

    const label = figma.createText();
    label.fontName = { family: 'Inter', style: 'Bold' };
    label.fontSize = 28;
    label.characters = sectionName;
    label.fills = [{ type: 'SOLID', color: hexToRgb(palette[0] || '#101820') }];
    section.appendChild(label);
    frame.appendChild(section);
  }

  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.closePlugin('Restaurant landing page design generated.');
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const value = parseInt(clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255
  };
}

main();`;
}
// Normalizes React agent output so generatedFiles may be an array or an object map keyed by file path/name.
function normalizeReactGeneration(rawGeneration, input) {
    const rawRecord = rawGeneration && typeof rawGeneration === 'object' ? rawGeneration : {};
    const rawGeneratedFiles = rawRecord.generatedFiles;
    const generatedFiles = Array.isArray(rawGeneratedFiles)
        ? rawGeneratedFiles.map((file) => {
            if (file && typeof file === 'object') {
                const record = file;
                return {
                    path: valueToText(record.path ?? record.filePath ?? record.name, ''),
                    content: valueToText(record.content ?? record.code ?? record.source, '')
                };
            }
            return {
                path: '',
                content: valueToText(file, '')
            };
        })
        : rawGeneratedFiles && typeof rawGeneratedFiles === 'object'
            ? Object.entries(rawGeneratedFiles).map(([fileName, fileValue]) => {
                const normalizedPath = fileName.includes('/')
                    ? fileName
                    : `generated-app/src/${fileName}`;
                return {
                    path: normalizedPath,
                    content: valueToText(fileValue, '')
                };
            })
            : [];
    const normalizedFiles = generatedFiles
        .map((file) => ({
        path: file.path.replace(/\\/g, '/').replace(/^src\//, 'generated-app/src/'),
        content: file.content
    }))
        .filter((file) => file.path && file.content);
    const appCss = normalizedFiles.find((file) => file.path === 'generated-app/src/App.css')?.content ?? '';
    const rawPreviewHtml = valueToText(rawRecord.previewHtml ?? rawRecord.html ?? rawRecord.standaloneHtml, '');
    const previewHtml = ensureStandalonePreviewHtml(rawPreviewHtml, appCss, input.designBrief);
    const normalizedGeneration = {
        summary: valueToText(rawRecord.summary, `Generated React UI for ${input.designBrief.brandName}.`),
        componentName: valueToText(rawRecord.componentName, `${slugify(input.designBrief.brandName).replace(/(^|-)([a-z])/g, (_match, _dash, char) => char.toUpperCase())}GeneratedPage`),
        previewHtml,
        generatedFiles: normalizedFiles
    };
    return reactGenerationResultSchema.parse(normalizedGeneration);
}
// Ensures the Railway preview is a fully self-contained HTML document with inline styling.
function ensureStandalonePreviewHtml(previewHtml, appCss, brief) {
    const hasHtmlDocument = /<!doctype html|<html[\s>]/i.test(previewHtml);
    const bodyMarkup = previewHtml.trim() || `<main><h1>${escapeHtml(brief.brandName)}</h1><p>${escapeHtml(brief.mood)}</p></main>`;
    const css = appCss.trim() || [
        'body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #f8fafc; color: #111827; }',
        'main { max-width: 960px; margin: 0 auto; padding: 48px 24px; }',
        'input, textarea, button { font: inherit; }'
    ].join('\n');
    const html = hasHtmlDocument
        ? bodyMarkup.replace(/<link[^>]+href=["'](?:\.\/)?App\.css["'][^>]*>/gi, '')
        : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(brief.brandName)}</title></head><body>${bodyMarkup}</body></html>`;
    if (/<style[\s>]/i.test(html)) {
        return html;
    }
    const styleTag = `<style>\n${css}\n</style>`;
    if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, `${styleTag}\n</head>`);
    }
    return `${styleTag}\n${html}`;
}
// Creates Figma design artifacts from the LLM brief and writes the plugin payload through MCP.
async function createFigmaDesignFromBrief(input) {
    const slug = slugify(input.designBrief.brandName);
    const designSpecPath = `figma-agent/${slug}-design-spec.json`;
    const pluginPayloadPath = `figma-agent/${slug}-plugin-code.js`;
    const nodes = [
        { name: 'Restaurant Landing Page Frame', type: 'frame', description: 'Desktop landing page frame generated from Slack prompt.' },
        ...input.designBrief.sections.map((section) => ({
            name: section,
            type: 'section',
            description: `Figma section for ${section}.`
        }))
    ];
    await writeGeneratedArtifactViaMcp({
        path: designSpecPath,
        content: JSON.stringify({ brief: input.designBrief, nodes }, null, 2)
    });
    await writeGeneratedArtifactViaMcp({
        path: pluginPayloadPath,
        content: buildFigmaPluginCode(input.designBrief)
    });
    return {
        ...input,
        figmaDesign: {
            fileName: `${input.designBrief.brandName} Landing Page`,
            frameName: `${input.designBrief.brandName} - Restaurant Landing Page`,
            figmaUrl: optionalEnv('FIGMA_FILE_URL') ?? null,
            pluginPayloadPath,
            designSpecPath,
            nodes
        }
    };
}
// Converts the Figma design artifact into React source files through an LLM code-generation agent.
async function generateReactFromFigmaDesign(input) {
    const infrastructureFiles = [
        {
            path: 'generated-app/package.json',
            content: JSON.stringify({
                scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
                dependencies: { '@vitejs/plugin-react': 'latest', vite: 'latest', react: 'latest', 'react-dom': 'latest' },
                devDependencies: {}
            }, null, 2)
        },
        {
            path: 'generated-app/index.html',
            content: '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>Generated UI</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.jsx"></script>\n</body>\n</html>\n'
        },
        { path: 'generated-app/src/main.jsx', content: "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n" }
    ];
    const prompt = [
        'Generate production-quality React/Vite source files from this Figma design artifact.',
        'Return JSON only with keys: summary, componentName, previewHtml, generatedFiles.',
        'generatedFiles must include exactly these app source files: generated-app/src/App.jsx and generated-app/src/App.css.',
        'Do not include package.json, index.html, or main.jsx; the runtime provides those infrastructure files.',
        'previewHtml must be a complete standalone HTML document that visually matches the generated React UI and can be served directly from Railway.',
        'previewHtml must include all CSS inside a <style> tag in the <head>. Do not use <link rel="stylesheet">, App.css links, external fonts, or remote assets.',
        'Use React function components and plain CSS only. Do not import external UI libraries or image assets.',
        'App.jsx must import ./App.css and export a default component.',
        'CSS must be responsive for mobile and desktop and must avoid text overlap.',
        'Visual quality is mandatory: create a refined, modern, high-fidelity page with strong spacing, hierarchy, custom form/control styling, hover/focus states, responsive layout, and polished color contrast.',
        'Do not output a plain centered form, unstyled browser-default controls, default serif typography, or sparse single-panel UI.',
        'If the prompt asks for a form, wrap it in a complete branded experience with a header/hero, supporting content, status/benefit cards, and an intentionally styled form surface.',
        'Use only local CSS in App.css. Include a global reset, body background, typography, layout shell, button states, input states, mobile breakpoints, and accessible focus styles.',
        'Keep colors balanced and professional. Do not rely on a single pale background color as the dominant visual system.',
        'The UI must fit the actual prompt and design brief, not a fixed restaurant template.',
        '',
        `Original Slack prompt: ${input.requestedWork}`,
        `Requester: ${input.requester}`,
        '',
        `Design brief JSON:\n${JSON.stringify(input.designBrief, null, 2)}`,
        '',
        `Figma artifact JSON:\n${JSON.stringify(input.figmaDesign, null, 2)}`
    ].join('\n');
    const generatedByAgent = normalizeReactGeneration(await callOpenAiJsonStrictRaw(prompt), input);
    const appJsx = generatedByAgent.generatedFiles.find((file) => file.path === 'generated-app/src/App.jsx');
    const appCss = generatedByAgent.generatedFiles.find((file) => file.path === 'generated-app/src/App.css');
    if (!appJsx || !appCss) {
        throw new Error('React Code Generator Agent must return generated-app/src/App.jsx and generated-app/src/App.css.');
    }
    return {
        ...input,
        reactGeneration: {
            ...generatedByAgent,
            generatedFiles: [
                ...infrastructureFiles,
                appJsx,
                appCss
            ]
        }
    };
}
// ---------------------------------------------------------
// NODE 1: MCP Filesystem Server for AI Delivery Request State
// ---------------------------------------------------------
let mcpClientPromise;
// Returns the singleton MCP client so every workflow step reuses the same in-process MCP connection.
async function getDeliveryMcpClient() {
    if (!mcpClientPromise) {
        mcpClientPromise = initializeDeliveryMcpClient();
    }
    return mcpClientPromise;
}
// Creates the MCP server, registers delivery database read/write tools, and connects a client through in-memory transport.
async function initializeDeliveryMcpClient() {
    const server = new McpServer({
        name: 'ai-delivery-filesystem',
        version: '1.0.0'
    });
    server.registerTool('read_delivery_database', {
        title: 'Read Delivery Database',
        description: 'Reads the root delivery-requests.json workflow database.'
    }, async () => ({
        content: [
            {
                type: 'text',
                text: fs.readFileSync(DELIVERY_DATABASE_PATH, 'utf-8')
            }
        ]
    }));
    server.registerTool('write_delivery_database', {
        title: 'Write Delivery Database',
        description: 'Writes the AI engineering delivery workflow database back to root delivery-requests.json.',
        inputSchema: {
            databaseJson: z.string()
        }
    }, async ({ databaseJson }) => {
        const parsedDatabase = deliveryDatabaseSchema.parse(JSON.parse(databaseJson));
        fs.writeFileSync(DELIVERY_DATABASE_PATH, `${JSON.stringify(parsedDatabase, null, 2)}\n`, 'utf-8');
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        ok: true,
                        path: DELIVERY_DATABASE_PATH,
                        recordsUpdated: parsedDatabase.requests.length
                    })
                }
            ]
        };
    });
    server.registerTool('write_generated_artifact', {
        title: 'Write Generated Artifact',
        description: 'Writes generated React, documentation, or Figma-agent artifact files to approved project folders.',
        inputSchema: {
            filePath: z.string(),
            content: z.string()
        }
    }, async ({ filePath, content }) => {
        const absolutePath = resolveGeneratedArtifactPath(filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content, 'utf-8');
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        ok: true,
                        path: absolutePath
                    })
                }
            ]
        };
    });
    const client = new Client({
        name: 'ai-delivery-mastra-client',
        version: '1.0.0'
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}
// Calls the MCP read_delivery_database tool and validates the returned JSON against the delivery database schema.
async function readDeliveryDatabaseViaMcp() {
    const client = await getDeliveryMcpClient();
    const result = await client.callTool({
        name: 'read_delivery_database',
        arguments: {}
    });
    const content = result.content;
    const textContent = content.find((item) => item.type === 'text');
    if (!textContent) {
        throw new Error('MCP read_delivery_database returned no text content.');
    }
    return deliveryDatabaseSchema.parse(JSON.parse(textContent.text));
}
// Calls the MCP write_delivery_database tool to persist the optimized workflow state and return mutation metadata.
async function writeDeliveryDatabaseViaMcp(database) {
    const client = await getDeliveryMcpClient();
    const result = await client.callTool({
        name: 'write_delivery_database',
        arguments: {
            databaseJson: JSON.stringify(database)
        }
    });
    const content = result.content;
    const textContent = content.find((item) => item.type === 'text');
    if (!textContent) {
        throw new Error('MCP write_delivery_database returned no text content.');
    }
    const parsedResult = z.object({
        ok: z.boolean(),
        path: z.string(),
        recordsUpdated: z.number()
    }).parse(JSON.parse(textContent.text));
    if (!parsedResult.ok) {
        throw new Error('MCP write_delivery_database reported a failed write.');
    }
    return {
        path: parsedResult.path,
        recordsUpdated: parsedResult.recordsUpdated
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
                generatedFiles: generationContext.reactGeneration.generatedFiles.map((file) => file.path)
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
        generatedFiles: generationContext.reactGeneration.generatedFiles.map((file) => file.path)
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
                generatedFiles: generationContext.reactGeneration.generatedFiles.map((file) => file.path)
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
        '## Acceptance Criteria',
        ...results.designBrief.acceptanceCriteria.map((item) => `- ${item}`),
        '',
        '## Implementation Plan',
        ...results.designBrief.implementationPlan.map((item) => `- ${item}`),
        '',
        '## Generated Files',
        ...results.reactGeneration.generatedFiles.map((file) => `- ${file.path}`)
    ].join('\n');
    await Promise.all([
        ...results.reactGeneration.generatedFiles.map((file) => writeGeneratedArtifactViaMcp(file)),
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
// Calls the MCP write_generated_artifact tool for React app files, Figma plugin payloads, and documentation artifacts.
async function writeGeneratedArtifactViaMcp(file) {
    const client = await getDeliveryMcpClient();
    const result = await client.callTool({
        name: 'write_generated_artifact',
        arguments: {
            filePath: file.path,
            content: file.content
        }
    });
    const content = result.content;
    const textContent = content.find((item) => item.type === 'text');
    if (!textContent) {
        throw new Error('MCP write_generated_artifact returned no text content.');
    }
    const parsedResult = z.object({
        ok: z.boolean(),
        path: z.string()
    }).parse(JSON.parse(textContent.text));
    if (!parsedResult.ok) {
        throw new Error('MCP write_generated_artifact reported a failed write.');
    }
    return { path: parsedResult.path };
}
// -----------------------------------------------------------------------
// NODE 3: Outgoing Slack Messenger (Dispatches Block Kit UI Elements)
// -----------------------------------------------------------------------
// Sends the final Slack Block Kit summary with the generated UI URL, design/code artifacts, and governance links.
async function dispatchSlackInteractiveCard(results) {
    const webhookUrl = requiredEnv('SLACK_WEBHOOK_URL');
    const generatedFileList = results.reactGeneration.generatedFiles.map((file) => `\`${file.path}\``).join(', ');
    const figmaPluginSessionUrl = `${getPublicBaseUrl()}/api/figma/session/${encodeURIComponent(results.requestId)}`;
    const governanceLines = [
        `*Generated UI:* <${results.generatedUiUrl}|Open generated page>`,
        results.prUrl ? `*GitHub Evidence PR:* <${results.prUrl}|Review PR>` : '*GitHub Evidence PR:* Not created',
        results.ticketUrl ? `*Linear Governance Ticket:* <${results.ticketUrl}|View ticket>` : '*Linear Governance Ticket:* Not created',
        `*Governance Status:* ${results.governanceStatus}`,
        `*Governance Notes:* ${results.governanceNotes.join(' | ')}`
    ];
    const slackPayload = {
        blocks: [
            {
                type: 'header',
                text: { type: 'plain_text', text: 'Generated UI Ready' }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Requester:* \`${results.requester}\`\n*Requested Work:* *${results.requestedWork}*\n*LLM Brief:* ${results.designBrief.brandName} ${results.designBrief.pageType}\n*Analysis Status:* ${results.analysisStatus === 'updated_existing' ? 'Updated an existing delivery record.' : 'Created a new delivery record.'}\n*Request ID:* \`${results.requestId}\``
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Figma Design Agent:* \`${results.figmaDesign.designSpecPath}\` + \`${results.figmaDesign.pluginPayloadPath}\`\n*Live Figma Plugin Session:* <${figmaPluginSessionUrl}|Fetch design payload>\n*React Code Generator:* ${results.reactGeneration.summary}\n*Generated React Files:* ${generatedFileList}`
                }
            },
            {
                type: 'divider'
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Railway Generated UI:* <${results.generatedUiUrl}|Open generated page>\n*Database Mutation:* \`${results.databasePath}\`\n*Records Tracked:* ${results.recordsUpdated}\n${governanceLines.join('\n')}\n*Delivery Mode:* *AI-assisted engineering workflow*`
                }
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        style: 'primary',
                        text: { type: 'plain_text', text: 'Open Generated UI' },
                        url: results.generatedUiUrl
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
// Creates or updates one file on the workflow branch, supporting both existing and brand-new generated artifacts.
async function upsertGitHubFile(octokit, owner, repo, branchName, filePath, content, message) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    let sha;
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
    }
    catch (error) {
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
    await octokit.repos.createOrUpdateFileContents(sha ? { ...requestParameters, sha } : requestParameters);
}
// Creates a GitHub branch, commits generated React/Figma/database evidence, and opens a PR.
async function createGitHubEvidencePr(results) {
    const octokit = getOctokit();
    const owner = optionalEnv('GITHUB_REPO_OWNER');
    const repo = optionalEnv('GITHUB_REPO_NAME');
    const baseBranch = optionalEnv('GITHUB_BASE_BRANCH') ?? 'develop';
    if (!octokit || !owner || !repo) {
        return null;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const branchName = `delivery/request-${results.requester.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;
    const updatedData = {
        organization: results.database.organization,
        lastUpdated: results.database.lastUpdated,
        requests: results.updatedRequestArray
    };
    const { data: baseRef } = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseRef.object.sha
    });
    await upsertGitHubFile(octokit, owner, repo, branchName, 'delivery-requests.json', `${JSON.stringify(updatedData, null, 2)}\n`, `[Governance] Track AI delivery request for ${results.requester}`);
    const localArtifactPaths = new Set([
        results.figmaDesign.designSpecPath,
        results.figmaDesign.pluginPayloadPath,
        ...results.reactGeneration.generatedFiles.map((file) => file.path),
        ...(results.updatedRequestArray.find((record) => record.id === results.requestId)?.generatedFiles ?? [])
    ]);
    for (const artifactPath of localArtifactPaths) {
        const absoluteArtifactPath = resolveGeneratedArtifactPath(artifactPath);
        if (!fs.existsSync(absoluteArtifactPath)) {
            console.warn(`Skipping missing generated artifact for GitHub PR: ${artifactPath}`);
            continue;
        }
        await upsertGitHubFile(octokit, owner, repo, branchName, artifactPath, fs.readFileSync(absoluteArtifactPath, 'utf-8'), `[Generated Artifact] Add ${artifactPath} for ${results.requestId}`);
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
            `- Generated files: ${results.reactGeneration.generatedFiles.map((file) => file.path).join(', ')}`
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
// Creates a Linear governance ticket and links it to the AI delivery request and optional GitHub PR.
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
        title: `[Governance] AI delivery request for ${results.requester}`,
        description: [
            'Automated compliance ticket for Slack-triggered AI engineering delivery.',
            '',
            `Requester: ${results.requester}`,
            `Requested work: ${results.requestedWork}`,
            `Analysis status: ${results.analysisStatus}`,
            `Request ID: ${results.requestId}`,
            `Risk level: ${results.designBrief.riskLevel}`,
            `Figma design spec: ${results.figmaDesign.designSpecPath}`,
            `Figma plugin payload: ${results.figmaDesign.pluginPayloadPath}`,
            `React component: ${results.reactGeneration.componentName}`,
            `Generated files: ${results.reactGeneration.generatedFiles.map((file) => file.path).join(', ')}`,
            '',
            'Acceptance criteria:',
            ...results.designBrief.acceptanceCriteria.map((item) => `- ${item}`),
            '',
            'Implementation plan:',
            ...results.designBrief.implementationPlan.map((item) => `- ${item}`),
            '',
            prUrl ? `GitHub evidence PR: ${prUrl}` : 'GitHub evidence PR: not created'
        ].join('\n'),
        priority: 1
    });
    const issueDetails = await issue.issue;
    return issueDetails?.url ? { ticketId: issueDetails.id, ticketUrl: issueDetails.url } : null;
}
// Coordinates optional GitHub PR creation, Linear ticket creation, approval URL generation, and status notes.
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
        analysisStatus: results.analysisStatus
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
    const generatedUiUrl = buildGeneratedUiUrl(results);
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
        generatedUiUrl,
        governanceStatus,
        governanceNotes: notes
    };
}
// ---------------------------------------------------------
// NODE 5: Mastra Multi-Step Orchestration State Machine
// ---------------------------------------------------------
// Defines the LLM prompt-understanding agent that expands the Slack request into a design brief.
const designBriefStep = createStep({
    id: 'generateDesignBriefWithLlm',
    description: 'Uses an LLM to turn the Slack prompt into a structured restaurant landing-page design brief.',
    inputSchema: executionContextSchema,
    outputSchema: designBriefResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 1: LLM Prompt Understanding Agent...');
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
        console.log('⏳ Running Node 2: Figma Design Agent...');
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
        console.log('⏳ Running Node 3: React Code Generator Agent...');
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
        console.log('⏳ Running Node 4: Delivery Record Agent...');
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
        console.log('⏳ Running Node 5: MCP Generated Artifact Mutation...');
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
        console.log('⏳ Running Node 6: MCP Delivery Database Mutation...');
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
    description: 'Sends the final Block Kit approval card to Slack.',
    inputSchema: governanceResultsSchema,
    outputSchema: workflowResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 8: Slack Bot Agent Dispatch...');
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
            approvalUiUrl: inputData.approvalUiUrl,
            generatedUiUrl: inputData.generatedUiUrl,
            governanceStatus: inputData.governanceStatus,
            governanceNotes: inputData.governanceNotes,
            slackDispatched: true
        };
    }
});
// Defines the Mastra governance step that creates GitHub and Linear records before approval.
const governanceStep = createStep({
    id: 'createGovernanceEvidence',
    description: 'Creates optional GitHub PR and Linear ticket evidence for the delivery request.',
    inputSchema: mutationResultsSchema,
    outputSchema: governanceResultsSchema,
    execute: async ({ inputData }) => {
        console.log('⏳ Running Node 7: GitHub + Linear Governance Agents...');
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
        requestedWork: 'Build me a landing page for a restaurant'
    };
    const runtimeResults = await deliveryOrchestrator.execute(executionContext);
    console.log('\n=======================================================');
    console.log('CHATOPS INTERACTIVE CONTROL CARD GENERATED SUCCESSFULLY');
    console.log('=======================================================');
    console.log(runtimeResults);
}
// Converts Slack slash command text into the requester and requested work expected by the workflow.
function parseSlackCommandText(textValue, requesterValue) {
    const slackInputText = typeof textValue === 'string' ? textValue.trim() : '';
    const requesterFromSlack = typeof requesterValue === 'string' && requesterValue.trim()
        ? requesterValue.trim()
        : 'slack.user@company.com';
    if (!slackInputText) {
        return {
            requester: requesterFromSlack,
            requestedWork: 'Build me a landing page for a restaurant'
        };
    }
    const [firstToken = '', ...remainingTokens] = slackInputText.split(/\s+/);
    const firstTokenLooksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(firstToken);
    if (firstTokenLooksLikeEmail && remainingTokens.length > 0) {
        return {
            requester: firstToken,
            requestedWork: remainingTokens.join(' ')
        };
    }
    return {
        requester: requesterFromSlack,
        requestedWork: slackInputText
    };
}
// Sends a consistent JSON HTTP response from Express route handlers.
function sendJson(response, statusCode, body) {
    response.status(statusCode).json(body);
}
// Escapes user-controlled values before rendering them inside the Railway approval HTML page.
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
// Reads the Figma design spec written by the workflow so a live Figma plugin session can materialize it.
function buildFigmaPluginSessionPayload(requestId) {
    const database = deliveryDatabaseSchema.parse(JSON.parse(fs.readFileSync(DELIVERY_DATABASE_PATH, 'utf-8')));
    const deliveryRecord = requestId === 'latest'
        ? [...database.requests].reverse().find((item) => item.figmaDesignSpecPath || item.designBrief)
        : database.requests.find((item) => item.id === requestId);
    if (!deliveryRecord) {
        throw new Error(`No delivery request was found for request ${requestId}.`);
    }
    let designSpec;
    if (deliveryRecord.figmaDesignSpecPath && fs.existsSync(resolveGeneratedArtifactPath(deliveryRecord.figmaDesignSpecPath))) {
        const specPath = resolveGeneratedArtifactPath(deliveryRecord.figmaDesignSpecPath);
        designSpec = z.object({
            brief: designBriefSchema,
            nodes: figmaDesignArtifactSchema.shape.nodes
        }).parse(JSON.parse(fs.readFileSync(specPath, 'utf-8')));
    }
    else if (deliveryRecord.designBrief) {
        designSpec = {
            brief: deliveryRecord.designBrief,
            nodes: [
                {
                    name: `${deliveryRecord.designBrief.brandName} Generated UI`,
                    type: 'frame',
                    description: 'Generated UI frame reconstructed from persisted delivery metadata.'
                },
                ...deliveryRecord.designBrief.sections.map((section) => ({
                    name: section,
                    type: 'section',
                    description: `Generated section for ${section}.`
                }))
            ]
        };
    }
    else {
        throw new Error(`No Figma design spec or persisted design brief was found for request ${requestId}.`);
    }
    return {
        status: 'ok',
        requestId: deliveryRecord.id,
        requester: deliveryRecord.requester,
        requestedWork: deliveryRecord.request,
        figmaFileUrl: deliveryRecord.figmaUrl ?? optionalEnv('FIGMA_FILE_URL') ?? null,
        designSpec,
        pluginPayloadPath: deliveryRecord.figmaPluginPayloadPath,
        generatedFiles: deliveryRecord.generatedFiles ?? []
    };
}
// Renders the generated UI directly from the workflow design brief so Slack can link to a live Railway page.
function renderGeneratedUi(requestId) {
    const database = deliveryDatabaseSchema.parse(JSON.parse(fs.readFileSync(DELIVERY_DATABASE_PATH, 'utf-8')));
    const deliveryRecord = requestId === 'latest'
        ? [...database.requests].reverse().find((item) => item.generatedPreviewHtml || item.designBrief || item.figmaDesignSpecPath)
        : database.requests.find((item) => item.id === requestId);
    if (deliveryRecord?.generatedPreviewHtml) {
        return deliveryRecord.generatedPreviewHtml;
    }
    const payload = buildFigmaPluginSessionPayload(requestId);
    const parsedPayload = z.object({
        requestId: z.string(),
        requester: z.string(),
        requestedWork: z.string(),
        designSpec: z.object({
            brief: designBriefSchema
        })
    }).parse(payload);
    const brief = parsedPayload.designSpec.brief;
    const palette = [
        brief.colorPalette[0] ?? '#101820',
        brief.colorPalette[1] ?? '#f7efe2',
        brief.colorPalette[2] ?? '#c94f3d',
        brief.colorPalette[3] ?? '#d7a86e',
        brief.colorPalette[4] ?? '#355e4b'
    ];
    const ink = palette[0] ?? '#101820';
    const canvas = palette[1] ?? '#f7efe2';
    const accent = palette[2] ?? '#c94f3d';
    const gold = palette[3] ?? '#d7a86e';
    const green = palette[4] ?? '#355e4b';
    const sectionCards = brief.sections.length > 0 ? brief.sections : ['Hero', 'Features', 'Call to action'];
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(brief.brandName)} Generated UI</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: ${escapeHtml(ink)}; background: ${escapeHtml(canvas)}; }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, ${escapeHtml(canvas)} 0%, #fffaf2 100%); }
    .nav { display: flex; justify-content: space-between; align-items: center; padding: 24px clamp(20px, 5vw, 80px); }
    .nav div { display: flex; gap: 18px; flex-wrap: wrap; }
    a { color: inherit; text-decoration: none; }
    .hero { min-height: 72vh; display: grid; align-content: center; padding: 40px clamp(20px, 7vw, 110px); background: ${escapeHtml(ink)}; color: ${escapeHtml(canvas)}; }
    .eyebrow { color: ${escapeHtml(gold)}; font-weight: 800; text-transform: uppercase; }
    h1 { font-size: clamp(54px, 9vw, 128px); line-height: .92; margin: 10px 0 20px; max-width: 960px; }
    .lede { font-size: clamp(20px, 3vw, 34px); max-width: 760px; color: rgba(247,239,226,.82); }
    .cta, button { width: fit-content; border: 0; border-radius: 999px; background: ${escapeHtml(accent)}; color: #fff; padding: 14px 22px; font-weight: 800; }
    .content-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; padding: 72px clamp(20px, 6vw, 96px); }
    .content-grid article, .final-cta { border-radius: 18px; background: #fff; padding: 28px; box-shadow: 0 18px 45px rgba(16,24,32,.08); }
    .story { display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); gap: 32px; padding: 40px clamp(20px, 6vw, 96px) 80px; }
    .section-list { display: flex; flex-wrap: wrap; gap: 12px; }
    .section-list span { border: 1px solid rgba(16,24,32,.15); border-radius: 999px; padding: 10px 14px; }
    .final-cta { margin: 0 clamp(20px, 6vw, 96px) 80px; background: ${escapeHtml(green)}; color: #fff; }
    .meta { padding: 16px clamp(20px, 5vw, 80px); color: #52606b; font-size: 14px; }
    @media (max-width: 760px) { .nav, .story { display: block; } .nav div { margin-top: 12px; } }
  </style>
</head>
<body>
  <nav class="nav">
    <strong>${escapeHtml(brief.brandName)}</strong>
    <div>
      <a href="#content">Content</a>
      <a href="#story">Story</a>
      <a href="#action">Action</a>
    </div>
  </nav>
  <section class="hero">
    <p class="eyebrow">${escapeHtml(brief.pageType)}</p>
    <h1>${escapeHtml(brief.brandName)}</h1>
    <p class="lede">${escapeHtml(brief.mood)} experience for ${escapeHtml(brief.audience)}.</p>
    <a class="cta" href="#action">${escapeHtml(brief.primaryCta)}</a>
  </section>
  <section id="content" class="content-grid">
    ${sectionCards.map((section) => `<article><p>Generated Section</p><h2>${escapeHtml(section)}</h2><span>${escapeHtml(brief.mood)} content generated from the design brief.</span></article>`).join('\n    ')}
  </section>
  <section id="story" class="story">
    <div>
      <p class="eyebrow">Generated From Prompt</p>
      <h2>${escapeHtml(parsedPayload.requestedWork)}</h2>
    </div>
    <div class="section-list">
      ${brief.sections.map((section) => `<span>${escapeHtml(section)}</span>`).join('\n      ')}
    </div>
  </section>
  <section id="action" class="final-cta">
    <h2>${escapeHtml(brief.primaryCta)}</h2>
    <p>This fallback preview was reconstructed from persisted design metadata.</p>
    <button>${escapeHtml(brief.primaryCta)}</button>
  </section>
  <p class="meta">Generated by request ${escapeHtml(parsedPayload.requestId)} for ${escapeHtml(parsedPayload.requester)}.</p>
</body>
</html>`;
}
// Locates the delivery record backing a generated preview route.
function getDeliveryRecordForRequest(requestId) {
    const database = deliveryDatabaseSchema.parse(JSON.parse(fs.readFileSync(DELIVERY_DATABASE_PATH, 'utf-8')));
    const deliveryRecord = requestId === 'latest'
        ? [...database.requests].reverse().find((item) => item.generatedFiles?.includes('generated-app/src/App.jsx'))
        : database.requests.find((item) => item.id === requestId);
    if (!deliveryRecord) {
        throw new Error(`No delivery request was found for request ${requestId}.`);
    }
    return deliveryRecord;
}
// Serves the generated React app through Vite so the preview uses App.jsx, App.css, and Vite transforms.
async function renderGeneratedViteUi(viteServer, requestUrl, requestId) {
    const deliveryRecord = getDeliveryRecordForRequest(requestId);
    const indexPath = path.join(GENERATED_APP_DIR, 'index.html');
    if (!fs.existsSync(indexPath)) {
        throw new Error(`Generated Vite app index.html was not found for request ${deliveryRecord.id}.`);
    }
    const sourceHtml = fs.readFileSync(indexPath, 'utf-8');
    const htmlWithMetadata = sourceHtml.replace(/<div\s+id=["']root["']\s*><\/div>/i, `<div id="root" data-request-id="${escapeHtml(deliveryRecord.id)}" data-request="${escapeHtml(deliveryRecord.request)}"></div>`);
    return viteServer.transformIndexHtml(requestUrl, htmlWithMetadata);
}
// Generates the Railway-hosted approval page for a specific AI engineering delivery request.
function renderApprovalUi(requestId, request) {
    const database = deliveryDatabaseSchema.parse(JSON.parse(fs.readFileSync(DELIVERY_DATABASE_PATH, 'utf-8')));
    const deliveryRecord = database.requests.find((item) => item.id === requestId);
    const requester = typeof request.query.requester === 'string' ? request.query.requester : deliveryRecord?.requester ?? 'unknown';
    const requestedWork = typeof request.query.work === 'string' ? request.query.work : deliveryRecord?.request ?? 'unknown';
    const analysisStatus = typeof request.query.status === 'string' ? request.query.status : 'pending';
    const ticketId = typeof request.query.ticketId === 'string' ? request.query.ticketId : '';
    const prNumber = typeof request.query.prNumber === 'string' ? request.query.prNumber : '';
    const prOwner = typeof request.query.prOwner === 'string' ? request.query.prOwner : '';
    const prRepo = typeof request.query.prRepo === 'string' ? request.query.prRepo : '';
    const generatedFiles = deliveryRecord?.generatedFiles?.join(', ') || 'not generated';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Delivery Approval</title>
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
      <h1>AI Delivery Approval</h1>
      <p class="sub">Railway-hosted approval surface generated by the Mastra engineering delivery workflow.</p>
    </header>
    <section>
      <dl>
        <dt>Requester</dt><dd>${escapeHtml(requester)}</dd>
        <dt>Requested Work</dt><dd>${escapeHtml(requestedWork)}</dd>
        <dt>Request ID</dt><dd>${escapeHtml(requestId)}</dd>
        <dt>Workstream</dt><dd>${escapeHtml(deliveryRecord?.workstream ?? 'unknown')}</dd>
        <dt>Analysis Status</dt><dd><span class="status">${escapeHtml(analysisStatus)}</span></dd>
        <dt>Figma Design</dt><dd>${escapeHtml(deliveryRecord?.figmaUrl ?? deliveryRecord?.figmaDesignSpecPath ?? 'not linked')}</dd>
        <dt>Figma Plugin Payload</dt><dd>${escapeHtml(deliveryRecord?.figmaPluginPayloadPath ?? 'not generated')}</dd>
        <dt>Generated Files</dt><dd>${escapeHtml(generatedFiles)}</dd>
        <dt>Risk Level</dt><dd>${escapeHtml(deliveryRecord?.riskLevel ?? 'unknown')}</dd>
        <dt>LLM Summary</dt><dd>${escapeHtml(deliveryRecord?.llmSummary ?? 'not available')}</dd>
        <dt>Linear Ticket ID</dt><dd>${escapeHtml(ticketId || 'not linked')}</dd>
        <dt>GitHub PR</dt><dd>${escapeHtml(prNumber && prOwner && prRepo ? `${prOwner}/${prRepo}#${prNumber}` : 'not linked')}</dd>
        <dt>Last Updated</dt><dd>${escapeHtml(deliveryRecord?.lastUpdatedAt ?? 'unknown')}</dd>
      </dl>
      <div class="actions">
        <button class="approve" data-decision="approved">Approve Delivery</button>
        <button class="block" data-decision="blocked">Request Changes</button>
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
        const response = await fetch('/api/approval/${encodeURIComponent(requestId)}', {
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
// Moves the linked Linear ticket to Done for approvals or a canceled/blocked state for rejections.
async function updateLinearTicketFromApproval(ticketId, decision, requestId) {
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
        body: `Railway approval portal decision: **${decision}** for AI delivery request \`${requestId}\`.`
    });
    return `Linear ticket moved to ${targetState.name}.`;
}
// Merges the linked GitHub PR when approved or closes it with a comment when blocked.
async function updateGitHubPrFromApproval(prOwner, prRepo, prNumberValue, decision, requestId) {
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
            commit_title: `[Governance Approved] Merge AI delivery request ${requestId}`
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
        body: `Railway approval portal decision: **blocked** for AI delivery request \`${requestId}\`. Closing this PR without merge.`
    });
    return `GitHub PR #${pull_number} closed without merge.`;
}
// Starts the Express service, exposes Slack intake routes, Vite generated UI routes, approval routes, and health checks.
async function startServer() {
    const app = express();
    const port = Number(process.env.PORT ?? 3000);
    const shouldUseExactPort = Boolean(process.env.PORT);
    const generatedAppViteServer = await createGeneratedAppViteServer();
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
    app.get('/generated/:requestId', async (request, response) => {
        try {
            response.status(200).type('html').send(await renderGeneratedViteUi(generatedAppViteServer, request.originalUrl, request.params.requestId));
        }
        catch (error) {
            sendJson(response, 404, {
                status: 'not_found',
                message: getErrorMessage(error)
            });
        }
    });
    // Approval page endpoint renders the Railway-hosted UI for the request ID and query-string context.
    app.get('/approval/:requestId', (request, response) => {
        response.status(200).type('html').send(renderApprovalUi(request.params.requestId, request));
    });
    // Approval action endpoint records approve/block decisions and updates linked GitHub and Linear records.
    app.post('/api/approval/:requestId', async (request, response) => {
        const decision = request.body?.decision === 'blocked' ? 'blocked' : 'approved';
        console.log('Railway approval UI decision recorded:', {
            requestId: request.params.requestId,
            decision,
            ticketId: request.body?.ticketId,
            prOwner: request.body?.prOwner,
            prRepo: request.body?.prRepo,
            prNumber: request.body?.prNumber
        });
        const messages = [];
        const errors = [];
        try {
            messages.push(await updateGitHubPrFromApproval(request.body?.prOwner, request.body?.prRepo, request.body?.prNumber, decision, request.params.requestId));
        }
        catch (error) {
            console.error('GitHub approval update failure:', error);
            errors.push(`GitHub update failed: ${getErrorMessage(error)}`);
        }
        try {
            messages.push(await updateLinearTicketFromApproval(request.body?.ticketId, decision, request.params.requestId));
        }
        catch (error) {
            console.error('Linear approval update failure:', error);
            errors.push(`Linear update failed: ${getErrorMessage(error)}`);
        }
        if (errors.length === 0) {
            sendJson(response, 200, {
                status: 'ok',
                decision,
                message: `Delivery request ${decision} for ${request.params.requestId}. ${messages.join(' ')}`
            });
            return;
        }
        sendJson(response, 500, {
            status: 'error',
            decision,
            message: `Decision recorded, but follow-up update failed. ${[...messages, ...errors].join(' ')}`
        });
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
    // Vite middleware is mounted after API routes so Slack/GitHub/Linear endpoints are never intercepted.
    app.use(generatedAppViteServer.middlewares);
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

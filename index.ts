import express, { type Response } from 'express';
import { Mastra } from '@mastra/core/mastra';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import dotenv from 'dotenv';
import { z } from 'zod';
import {
  analysisResultsSchema,
  designBriefResultsSchema,
  designBriefSchema,
  executionContextSchema,
  figmaDesignResultsSchema,
  governanceResultsSchema,
  mutationResultsSchema,
  reactGenerationResultSchema,
  reactGenerationResultsSchema,
  uiQualityReviewSchema,
  workflowResultsSchema
} from './schemas/schemas.js';
import type {
  AnalysisResults,
  DeliveryDatabase,
  DeliveryRecord,
  DesignBrief,
  DesignBriefResults,
  ExecutionContext,
  FigmaDesignResults,
  GeneratedFile,
  GovernanceResults,
  MutationResults,
  ReactGenerationResult,
  ReactGenerationResults,
  RequestWithRawBody,
  UiQualityReview,
  WorkflowResults
} from './types/types.js';
import {
  buildGeneratedUiUrl,
  daysSince,
  escapeHtml,
  getErrorMessage,
  optionalEnv,
  requiredEnv,
  slugify
} from './runtime/runtime.js';
import { triggerRailwayDeployment, waitForRailwayGeneratedUi } from './railway/railway.js';
import {
  readDeliveryDatabaseViaMcp,
  writeDeliveryDatabaseViaMcp,
  writeGeneratedArtifactViaMcp
} from './mcp/deliveryMcp.js';
import {
  closeLinearTicketAfterMerge,
  createGitHubEvidenceBranch,
  ensureEvidencePullRequest,
  mergeGitHubPrAfterReview,
  postGitHubPrReviewComment,
  provisionGovernanceIntake,
  syncEvidenceToGitHubBranch
} from './governance/governanceIntegrations.js';
import {
  dispatchSlackInteractiveCard,
  parseSlackCommandText
} from './slack/slack.js';
import {
  buildFigmaPluginSessionPayload,
  renderGeneratedUi
} from './views/deliveryViews.js';

dotenv.config();

// Extracts plain text from OpenAI Chat Completions JSON mode responses.
function extractChatCompletionText(payload: unknown): string {
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
async function callOpenAiJson<T>(prompt: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
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

// Calls OpenAI and returns raw JSON so the caller can normalize common model shape drift before validation.
async function callOpenAiJsonStrictRaw(prompt: string): Promise<unknown> {
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

// Produces a reliable local design brief when the LLM is unavailable.
function fallbackDesignBrief(requestedWork: string): DesignBrief {
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

// Converts flexible LLM brief output into the strict internal DesignBrief contract used by downstream agents.
function valueToText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => valueToText(item, '')).filter(Boolean).join(', ');
    return joined || fallback;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
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
function valueToTextArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => valueToText(item, '')).filter(Boolean);
    return normalized.length > 0 ? normalized : fallback;
  }

  if (value && typeof value === 'object') {
    const normalized = Object.values(value as Record<string, unknown>).map((item) => valueToText(item, '')).filter(Boolean);
    return normalized.length > 0 ? normalized : fallback;
  }

  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  }

  return fallback;
}

// Normalizes model variants like "Medium" into the strict risk enum.
function normalizeRiskLevel(value: unknown): DesignBrief['riskLevel'] {
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
function normalizeDesignBrief(rawBrief: unknown, requestedWork: string): DesignBrief {
  const fallback = fallbackDesignBrief(requestedWork);
  const rawRecord = rawBrief && typeof rawBrief === 'object' ? rawBrief as Record<string, unknown> : {};
  const normalizedBrief: DesignBrief = {
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
async function generateDesignBriefWithLlm(context: ExecutionContext): Promise<DesignBriefResults> {
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

// Builds the Figma plugin code that can materialize the generated design brief into real Figma nodes.
function buildFigmaPluginCode(brief: DesignBrief): string {
  const sectionData = JSON.stringify(brief.sections, null, 2);
  const palette = JSON.stringify(brief.colorPalette, null, 2);

  return `const sections = ${sectionData};
const palette = ${palette};

async function main() {
  const frame = figma.createFrame();
  frame.name = ${JSON.stringify(brief.brandName)} + ' - Generated Experience';
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
  figma.closePlugin('Design generated from delivery brief.');
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
function normalizeReactGeneration(rawGeneration: unknown, input: FigmaDesignResults): ReactGenerationResult {
  const rawRecord = rawGeneration && typeof rawGeneration === 'object' ? rawGeneration as Record<string, unknown> : {};
  const rawGeneratedFiles = rawRecord.generatedFiles;
  const generatedFiles = Array.isArray(rawGeneratedFiles)
    ? rawGeneratedFiles.map((file) => {
        if (file && typeof file === 'object') {
          const record = file as Record<string, unknown>;
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
      ? Object.entries(rawGeneratedFiles as Record<string, unknown>).map(([fileName, fileValue]) => {
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

  const normalizedGeneration: ReactGenerationResult = {
    summary: valueToText(rawRecord.summary, `Generated React UI for ${input.designBrief.brandName}.`),
    componentName: valueToText(rawRecord.componentName, `${slugify(input.designBrief.brandName).replace(/(^|-)([a-z])/g, (_match, _dash, char: string) => char.toUpperCase())}GeneratedPage`),
    previewHtml,
    generatedFiles: normalizedFiles
  };

  return reactGenerationResultSchema.parse(normalizedGeneration);
}

// Ensures the Railway preview is a fully self-contained HTML document with inline styling.
function ensureStandalonePreviewHtml(previewHtml: string, appCss: string, brief: DesignBrief): string {
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
async function createFigmaDesignFromBrief(input: DesignBriefResults): Promise<FigmaDesignResults> {
  const slug = slugify(input.designBrief.brandName);
  const designSpecPath = `figma-agent/${slug}-design-spec.json`;
  const pluginPayloadPath = `figma-agent/${slug}-plugin-code.js`;
  const designSystem = {
    palette: input.designBrief.colorPalette,
    typography: input.designBrief.typography,
    spacingScale: ['8px', '12px', '16px', '24px', '32px', '48px', '72px', '96px'],
    cornerRadius: ['8px', '12px', '20px', '28px'],
    elevation: ['subtle card shadow', 'hero media shadow', 'sticky nav blur']
  };
  const layoutBlueprint = {
    desktop: '1440px responsive experience with clear navigation, high-impact hero, intentional section hierarchy, supporting content blocks, conversion-focused panels, and a polished footer.',
    tablet: 'Selective two-column layouts that collapse gracefully while preserving hierarchy and spacing rhythm.',
    mobile: 'Single-column flow with readable typography, full-width CTAs, stacked cards, and no content overlap.',
    qualityBar: 'The generated React implementation should feel production-ready and domain-appropriate, not a wireframe or plain form.'
  };
  const interactionNotes = [
    'Primary CTA needs hover, active, and focus-visible states.',
    'Inputs/selects/buttons must be custom styled if the design includes a form.',
    'Cards should have intentional spacing, hierarchy, and responsive dimensions.',
    'Avoid browser-default controls and sparse one-panel layouts.'
  ];
  const nodes = [
    {
      name: 'Landing Page Frame',
      type: 'frame' as const,
      description: `${input.designBrief.pageType} desktop frame with responsive design guidance, brand palette, typographic hierarchy, and conversion-focused content sections.`
    },
    ...input.designBrief.sections.map((section) => ({
      name: section,
      type: 'section' as const,
      description: `High-fidelity section for ${section}. Include layout intent, visual hierarchy, spacing, CTA behavior, and responsive treatment.`
    }))
  ];

  await writeGeneratedArtifactViaMcp({
    path: designSpecPath,
    content: JSON.stringify({ brief: input.designBrief, designSystem, layoutBlueprint, interactionNotes, nodes }, null, 2)
  });
  await writeGeneratedArtifactViaMcp({
    path: pluginPayloadPath,
    content: buildFigmaPluginCode(input.designBrief)
  });

  return {
    ...input,
    figmaDesign: {
      fileName: `${input.designBrief.brandName} Landing Page`,
      frameName: `${input.designBrief.brandName} - Generated Experience`,
      figmaUrl: optionalEnv('FIGMA_FILE_URL') ?? null,
      pluginPayloadPath,
      designSpecPath,
      nodes
    }
  };
}

// Converts the Figma design artifact into React source files through an LLM code-generation agent.
async function generateReactFromFigmaDesign(input: FigmaDesignResults, reviewerFeedback?: string): Promise<ReactGenerationResults> {
  const infrastructureFiles: GeneratedFile[] = [
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
    'If the prompt specifies a domain, include the expected domain sections and conversion path for that domain.',
    'Do not reinterpret the requested experience as a feedback form, survey, or admin tool unless the prompt explicitly asks for that.',
    'Use only local CSS in App.css. Include a global reset, body background, typography, layout shell, button states, input states, mobile breakpoints, and accessible focus styles.',
    'Keep colors balanced and professional. Do not rely on a single pale background color as the dominant visual system.',
    'The UI must fit the actual prompt and design brief, not a fixed template.',
    reviewerFeedback
      ? `UI Review Agent feedback from the previous attempt. Regenerate the React/CSS to address every point:\n${reviewerFeedback}`
      : 'This is the first generation attempt. Optimize for high visual quality on the first pass.',
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

// Normalizes UI reviewer output so the workflow can handle minor LLM response-shape drift.
function normalizeUiQualityReview(rawReview: unknown): UiQualityReview {
  const rawRecord = rawReview && typeof rawReview === 'object' ? rawReview as Record<string, unknown> : {};
  const numericScore = Number(rawRecord.score ?? rawRecord.qualityScore ?? rawRecord.overallScore ?? 0);
  const score = Math.max(0, Math.min(100, Number.isFinite(numericScore) ? numericScore : 0));
  const uiQualityScoreRaw = Number(rawRecord.uiQualityScore ?? score);
  const codeQualityScoreRaw = Number(rawRecord.codeQualityScore ?? score);
  const requirementCoverageScoreRaw = Number(rawRecord.requirementCoverageScore ?? rawRecord.businessRequirementScore ?? score);
  const uiQualityScore = Math.max(0, Math.min(100, Number.isFinite(uiQualityScoreRaw) ? uiQualityScoreRaw : score));
  const codeQualityScore = Math.max(0, Math.min(100, Number.isFinite(codeQualityScoreRaw) ? codeQualityScoreRaw : score));
  const requirementCoverageScore = Math.max(0, Math.min(100, Number.isFinite(requirementCoverageScoreRaw) ? requirementCoverageScoreRaw : score));
  const findings = valueToTextArray(rawRecord.findings ?? rawRecord.issues ?? rawRecord.recommendations, [
    'Review response was incomplete; regenerate with stronger UI polish, cleaner React/CSS architecture, and tighter requirement coverage.'
  ]);
  const codeFindings = valueToTextArray(rawRecord.codeFindings ?? rawRecord.bestPracticeFindings ?? rawRecord.codeIssues, []);
  const requirementFindings = valueToTextArray(rawRecord.requirementFindings ?? rawRecord.businessRequirementFindings ?? rawRecord.requirementGaps, []);
  const blockingIssues = valueToTextArray(rawRecord.blockingIssues ?? rawRecord.blockers, []);
  const regenerationPrompt = valueToText(
    rawRecord.regenerationPrompt ?? rawRecord.feedback ?? rawRecord.revisionPrompt,
    [...findings, ...codeFindings, ...requirementFindings, ...blockingIssues].join('\n')
  );
  const passed = typeof rawRecord.passed === 'boolean'
    ? rawRecord.passed
    : score >= 82 && uiQualityScore >= 80 && codeQualityScore >= 80 && requirementCoverageScore >= 80 && blockingIssues.length === 0;

  return uiQualityReviewSchema.parse({
    uiQualityScore,
    codeQualityScore,
    requirementCoverageScore,
    score,
    passed: passed && score >= 82 && blockingIssues.length === 0,
    findings,
    codeFindings,
    requirementFindings,
    blockingIssues,
    regenerationPrompt
  });
}

// Reviews generated React/CSS for visual quality, code quality, and business requirement coverage.
async function reviewReactUiQuality(input: ReactGenerationResults): Promise<UiQualityReview> {
  const appJsx = input.reactGeneration.generatedFiles.find((file) => file.path === 'generated-app/src/App.jsx')?.content ?? '';
  const appCss = input.reactGeneration.generatedFiles.find((file) => file.path === 'generated-app/src/App.css')?.content ?? '';
  const prompt = [
    'Review this generated React/Vite implementation as a principal frontend reviewer.',
    'Return JSON only with keys: uiQualityScore, codeQualityScore, requirementCoverageScore, score, passed, findings, codeFindings, requirementFindings, blockingIssues, regenerationPrompt.',
    'Each score must be a number from 0 to 100.',
    'passed must only be true when score is at least 82, all sub-scores are at least 80, and there are no blockingIssues.',
    'findings should summarize overall quality gaps.',
    'codeFindings must focus on React/CSS correctness, maintainability, accessibility, responsiveness, and best practices.',
    'requirementFindings must focus on whether business intent from the Slack prompt and acceptance criteria is fully covered.',
    'blockingIssues should only contain severe release blockers.',
    'regenerationPrompt must be directly actionable for regenerating improved App.jsx and App.css.',
    'Reject plain centered forms, sparse layouts, browser-default controls, weak hierarchy, code smells, and requirement mismatch.',
    '',
    `Original Slack prompt: ${input.requestedWork}`,
    '',
    `Design brief JSON:\n${JSON.stringify(input.designBrief, null, 2)}`,
    '',
    `Figma artifact JSON:\n${JSON.stringify(input.figmaDesign, null, 2)}`,
    '',
    `Generated App.jsx:\n${appJsx}`,
    '',
    `Generated App.css:\n${appCss}`
  ].join('\n');

  return normalizeUiQualityReview(await callOpenAiJsonStrictRaw(prompt));
}

// ---------------------------------------------------------
// NODE 2: AI Delivery Request Analysis Logic
// ---------------------------------------------------------
// Analyzes the incoming engineering request, updates matching draft work, or creates a new delivery record.
async function runDeliveryAnalysis(generationContext: ReactGenerationResults): Promise<AnalysisResults> {
  const database = await readDeliveryDatabaseViaMcp();
  const matchingRequests = database.requests.filter((record) => record.request.toLowerCase() === generationContext.requestedWork.toLowerCase());
  const existingRequesterRecord = matchingRequests.find(
    (record) => record.requester.toLowerCase() === generationContext.requester.toLowerCase()
  );

  if (existingRequesterRecord) {
    const refreshedRequestArray = database.requests.map((record) =>
      record.id === existingRequesterRecord.id
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
        : record
    );

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

  const newRecord: DeliveryRecord = {
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
    ? database.requests.map((record) =>
        record.id === reusableDraft.id
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
          : record
      )
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
async function persistGeneratedArtifacts(results: AnalysisResults): Promise<AnalysisResults> {
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
  const nonGeneratedAppArtifacts = results.reactGeneration.generatedFiles.filter(
    (file) => !file.path.replace(/\\/g, '/').startsWith('generated-app/')
  );

  await Promise.all([
    ...nonGeneratedAppArtifacts.map((file) => writeGeneratedArtifactViaMcp(file)),
    writeGeneratedArtifactViaMcp({ path: planPath, content: planContent })
  ]);

  const updatedRequestArray = results.updatedRequestArray.map((record) =>
    record.id === results.requestId
      ? {
          ...record,
          generatedFiles: [...results.reactGeneration.generatedFiles.map((file) => file.path), planPath]
        }
      : record
  );

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
async function persistReviewIteration(results: MutationResults, review: UiQualityReview, reactGeneration: ReactGenerationResult): Promise<MutationResults> {
  const updatedRequestArray = results.updatedRequestArray.map((record) =>
    record.id === results.requestId
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
      : record
  );

  const updatedDatabase: DeliveryDatabase = {
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
async function createGovernanceEvidence(results: MutationResults): Promise<GovernanceResults> {
  const notes: string[] = [...(results.governanceNotes ?? [])];
  let prUrl: string | null = null;
  let prNumber: number | null = null;
  let prOwner: string | null = results.prOwner ?? null;
  let prRepo: string | null = results.prRepo ?? null;
  let branchName: string | null = results.branchName ?? null;
  let ticketId: string | null = results.ticketId ?? null;
  let ticketUrl: string | null = results.ticketUrl ?? null;
  const hasGitHubEnv = Boolean(optionalEnv('GITHUB_TOKEN') && optionalEnv('GITHUB_REPO_OWNER') && optionalEnv('GITHUB_REPO_NAME'));
  const maxAttempts = Math.max(1, Number(optionalEnv('REVIEW_MAX_ATTEMPTS') ?? '3'));
  let workingResults: MutationResults = results;
  let finalReview: UiQualityReview;
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
      } else {
        notes.push('GitHub skipped: branch metadata unavailable.');
      }
    } else {
      notes.push('GitHub skipped: missing GITHUB_TOKEN, GITHUB_REPO_OWNER, or GITHUB_REPO_NAME in this runtime.');
    }
  } catch (error: unknown) {
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
      } catch (error: unknown) {
        notes.push(`GitHub merge failed after passing review: ${getErrorMessage(error)}`);
      }
    }
  } else {
    notes.push('PR review loop skipped because PR metadata was unavailable.');
  }

  if (ticketId && mergedToBase) {
    try {
      const ticketUpdate = await closeLinearTicketAfterMerge(ticketId, workingResults.requestId);
      notes.push(ticketUpdate);
    } catch (error: unknown) {
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
    } as const;
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
  async execute(context: ExecutionContext): Promise<WorkflowResults> {
    try {
      const workflow = mastra.getWorkflow('engineeringDeliveryWorkflow');
      const run = await workflow.createRun();
      const result = await run.start({ inputData: context });

      if (result.status !== 'success') {
        throw result.status === 'failed' ? result.error : new Error(`Workflow exited with status ${result.status}`);
      }

      console.log('✅ Orchestration completed successfully.');
      return result.result;
    } catch (error: unknown) {
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
function sendJson(response: Response, statusCode: number, body: Record<string, unknown>) {
  response.status(statusCode).json(body);
}

// Starts the Express service, exposes Slack intake routes, generated UI routes, Figma payload routes, and health checks.
async function startServer() {
  const app = express();
  const port = Number(process.env.PORT ?? 3000);
  const shouldUseExactPort = Boolean(process.env.PORT);

  app.use(
    express.urlencoded({
      extended: false,
      verify: (request, _response, buffer) => {
        (request as RequestWithRawBody).rawBody = buffer.toString('utf-8');
      }
    })
  );
  app.use(
    express.json({
      verify: (request, _response, buffer) => {
        (request as RequestWithRawBody).rawBody = buffer.toString('utf-8');
      }
    })
  );

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
    } catch (error: unknown) {
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
    } catch (error: unknown) {
      sendJson(response, 404, {
        status: 'not_found',
        message: getErrorMessage(error)
      });
    }
  });

  // Slack slash-command endpoint acknowledges the request quickly and launches the Mastra workflow asynchronously.
  app.post('/api/slack/command', async (request: RequestWithRawBody, response: Response) => {
    const bodyData = request.rawBody ?? JSON.stringify(request.body ?? {});
    console.log('📥 [Incoming Request] Received Slash Command invocation from Slack. Raw payload:', bodyData);

    const { requester, requestedWork } = parseSlackCommandText(request.body?.text, request.body?.user_name ?? request.body?.user_id);
    response.status(200).type('text/plain').send(`⏳ Generating UI for ${requestedWork}. I will post the Railway URL here when it is ready...`);

    try {
      await deliveryOrchestrator.execute({ requester, requestedWork });
    } catch (error: unknown) {
      console.error('❌ Slack endpoint runtime failure:', error);
    }
  });

  // Binds the Express app to a port and auto-increments locally if the default port is already in use.
  const listen = (targetPort: number) => {
    const server = app.listen(targetPort, () => {
      console.log(`AI engineering delivery agent service listening on port ${targetPort}`);
    });

    server.once('error', (error: NodeJS.ErrnoException) => {
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
    } catch (error: unknown) {
      console.error('Simulation run encountered an operational fault:', getErrorMessage(error));
    }
  }

  await startServer();
}

bootstrap();

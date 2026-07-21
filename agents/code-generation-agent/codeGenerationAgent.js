import { reactGenerationResultSchema } from '../../schemas/schemas.js';
import { escapeHtml, slugify } from '../../services/runtime/runtime.js';
import { callOpenAiJsonStrictRaw, valueToText } from '../../agent-utils/agentUtils.js';
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
// Converts the Figma design artifact into React source files through an LLM code-generation agent.
export async function generateReactFromFigmaDesign(input, reviewerFeedback) {
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

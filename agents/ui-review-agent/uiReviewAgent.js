import { uiQualityReviewSchema } from '../../schemas/schemas.js';
import { callOpenAiJsonStrictRaw, valueToText, valueToTextArray } from '../../agent-utils/agentUtils.js';
// Normalizes UI reviewer output so the workflow can handle minor LLM response-shape drift.
function normalizeUiQualityReview(rawReview) {
    const rawRecord = rawReview && typeof rawReview === 'object' ? rawReview : {};
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
    const regenerationPrompt = valueToText(rawRecord.regenerationPrompt ?? rawRecord.feedback ?? rawRecord.revisionPrompt, [...findings, ...codeFindings, ...requirementFindings, ...blockingIssues].join('\n'));
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
export async function reviewReactUiQuality(input) {
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

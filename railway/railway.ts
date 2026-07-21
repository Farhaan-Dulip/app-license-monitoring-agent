import { delay, getErrorMessage, optionalEnv } from '../runtime/runtime.js';

// Triggers Railway deployment through a deploy hook when configured.
export async function triggerRailwayDeployment(): Promise<string> {
  const deployHookUrl = optionalEnv('RAILWAY_DEPLOY_HOOK_URL');
  if (!deployHookUrl) {
    return 'Railway deploy hook not configured; deployment will follow repository integration settings.';
  }

  const response = await fetch(deployHookUrl, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Railway deploy hook failed with ${response.status}: ${await response.text()}`);
  }

  return 'Railway deployment hook triggered.';
}

// Polls the public generated UI route so Slack only receives an app URL once Railway is serving it.
export async function waitForRailwayGeneratedUi(generatedUiUrl: string): Promise<string> {
  const maxChecks = Math.max(1, Number(optionalEnv('RAILWAY_DEPLOY_MAX_CHECKS') ?? '20'));
  const delayMs = Math.max(500, Number(optionalEnv('RAILWAY_DEPLOY_POLL_MS') ?? '3000'));
  let lastStatus = 'not checked';

  for (let attempt = 1; attempt <= maxChecks; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.min(delayMs, 8000));
      const response = await fetch(generatedUiUrl, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeout);
      lastStatus = `${response.status} ${response.statusText}`.trim();

      if (response.ok) {
        const body = await response.text();
        if (!body.includes('"status":"not_found"') && !body.includes('No delivery request was found')) {
          return `Railway generated UI is live after ${attempt} check(s).`;
        }
        lastStatus = 'generated route returned not_found';
      }
    } catch (error: unknown) {
      lastStatus = getErrorMessage(error);
    }

    if (attempt < maxChecks) {
      await delay(delayMs);
    }
  }

  throw new Error(`Railway generated UI was not ready after ${maxChecks} check(s). Last status: ${lastStatus}.`);
}

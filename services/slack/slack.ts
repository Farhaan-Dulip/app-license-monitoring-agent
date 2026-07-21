import { getPublicBaseUrl, requiredEnv } from '../runtime/runtime.js';
import type { ExecutionContext, GovernanceResults } from '../../types/types.js';

// Converts Slack slash command text into the requester and requested work expected by the workflow.
export function parseSlackCommandText(textValue: unknown, requesterValue?: unknown): ExecutionContext {
  const slackInputText = typeof textValue === 'string' ? textValue.trim() : '';
  const requesterFromSlack = typeof requesterValue === 'string' && requesterValue.trim()
    ? requesterValue.trim()
    : 'slack.user@company.com';

  if (!slackInputText) {
    return {
      requester: requesterFromSlack,
      requestedWork: 'Build a modern product landing page'
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

// Sends the final Slack Block Kit summary with the generated UI URL, design/code artifacts, and governance links.
export async function dispatchSlackInteractiveCard(results: GovernanceResults): Promise<void> {
  const webhookUrl = requiredEnv('SLACK_WEBHOOK_URL');
  const generatedFileList = results.reactGeneration.generatedFiles.map((file) => `\`${file.path}\``).join(', ');
  const figmaPluginSessionUrl = `${getPublicBaseUrl()}/api/figma/session/${encodeURIComponent(results.requestId)}`;
  const fallbackActionUrl = results.releaseReady
    ? results.generatedUiUrl
    : results.prUrl ?? results.ticketUrl ?? results.generatedUiUrl;
  const releaseStatusLine = results.releaseReady
    ? `*Generated UI:* <${results.generatedUiUrl}|Open generated page>`
    : '*Generated UI:* Not released yet. Review failed or merge/deployment is still pending.';
  const railwayLine = results.releaseReady
    ? `*Railway Generated UI:* <${results.generatedUiUrl}|Open generated page>`
    : '*Railway Generated UI:* Not published because the delivery has not passed governance.';
  const reviewLine = results.uiQualityReview
    ? `*UI Review Agent:* Score ${results.uiQualityReview.score} / 100 (${results.uiQualityReview.passed ? 'passed' : 'did not pass'})`
    : '*UI Review Agent:* Not reviewed';
  const governanceLines = [
    releaseStatusLine,
    results.prUrl ? `*GitHub Evidence PR:* <${results.prUrl}|Review PR>` : '*GitHub Evidence PR:* Not created',
    results.ticketUrl ? `*Linear Governance Ticket:* <${results.ticketUrl}|View ticket>` : '*Linear Governance Ticket:* Not created',
    `*Governance Status:* ${results.governanceStatus}`,
    `*Governance Notes:* ${results.governanceNotes.join(' | ')}`
  ];

  const slackPayload = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: results.releaseReady ? 'Generated UI Ready' : 'Generated UI Needs Review' }
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
          text: `*Figma Design Agent:* \`${results.figmaDesign.designSpecPath}\` + \`${results.figmaDesign.pluginPayloadPath}\`\n*Live Figma Plugin Session:* <${figmaPluginSessionUrl}|Fetch design payload>\n*React Code Generator:* ${results.reactGeneration.summary}\n${reviewLine}\n*Generated React Files:* ${generatedFileList}`
        }
      },
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${railwayLine}\n*Database Mutation:* \`${results.databasePath}\`\n*Records Tracked:* ${results.recordsUpdated}\n${governanceLines.join('\n')}\n*Delivery Mode:* *AI-assisted engineering workflow*`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: results.releaseReady ? 'Open Generated UI' : 'Open Governance PR' },
            url: results.releaseReady ? results.generatedUiUrl : fallbackActionUrl
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

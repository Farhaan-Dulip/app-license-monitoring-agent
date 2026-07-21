import * as fs from 'node:fs';
import { z } from 'zod';
import { deliveryDatabaseSchema, designBriefSchema, figmaDesignArtifactSchema } from '../schemas/schemas.js';
import { DELIVERY_DATABASE_PATH, optionalEnv, resolveGeneratedArtifactPath } from '../services/runtime/runtime.js';
// Reads the Figma design spec written by the workflow so a live Figma plugin session can materialize it.
export function buildFigmaPluginSessionPayload(requestId) {
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
// Renders the generated UI that the React Code Generator Agent persisted for Slack/Railway preview.
export function renderGeneratedUi(requestId) {
    const database = deliveryDatabaseSchema.parse(JSON.parse(fs.readFileSync(DELIVERY_DATABASE_PATH, 'utf-8')));
    const deliveryRecord = requestId === 'latest'
        ? [...database.requests].reverse().find((item) => item.generatedPreviewHtml)
        : database.requests.find((item) => item.id === requestId);
    if (deliveryRecord?.generatedPreviewHtml) {
        return deliveryRecord.generatedPreviewHtml;
    }
    throw new Error(`No generated preview HTML was found for request ${requestId}.`);
}

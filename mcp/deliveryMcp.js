import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { deliveryDatabaseSchema } from '../schemas/schemas.js';
import { DELIVERY_DATABASE_PATH, resolveGeneratedArtifactPath } from '../runtime/runtime.js';
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
export async function readDeliveryDatabaseViaMcp() {
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
export async function writeDeliveryDatabaseViaMcp(database) {
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
// Calls the MCP write_generated_artifact tool for Figma payloads and documentation artifacts.
export async function writeGeneratedArtifactViaMcp(file) {
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

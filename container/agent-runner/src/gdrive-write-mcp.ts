/**
 * Google Drive Write MCP Server
 * Provides file creation tools for Google Drive using OAuth credentials.
 * Credentials are read from GDRIVE_CREDS_DIR (same as the read-only MCP).
 */

import fs from 'fs';
import https from 'https';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const GDRIVE_CREDS_DIR = process.env.GDRIVE_CREDS_DIR || '/home/node/.gdrive-mcp';
const KEYS_PATH = path.join(GDRIVE_CREDS_DIR, 'gcp-oauth.keys.json');
const TOKEN_PATH = path.join(GDRIVE_CREDS_DIR, '.gdrive-server-credentials.json');

interface OAuthKeys {
  client_id: string;
  client_secret: string;
  token_uri: string;
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
  scope: string;
}

function readKeys(): OAuthKeys {
  const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  const creds = raw.installed || raw.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error('Missing client_id or client_secret in keys.json');
  }
  return {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    token_uri: creds.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

function readToken(): TokenData {
  return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
}

function writeToken(token: TokenData): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function httpRequest(
  method: string,
  url: string,
  accessToken: string,
  body?: string,
  contentType?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };
    if (body && contentType) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
    }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(): Promise<string> {
  let token = readToken();

  // Refresh if expired (with 60s buffer)
  if (Date.now() >= token.expiry_date - 60_000) {
    const keys = readKeys();
    const params = new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    });
    const resp = await httpPost(keys.token_uri, params.toString(), {});
    const refreshed = JSON.parse(resp);
    if (!refreshed.access_token) {
      throw new Error(`Token refresh failed: ${resp}`);
    }
    token = {
      ...token,
      access_token: refreshed.access_token,
      expiry_date: Date.now() + (refreshed.expires_in || 3600) * 1000,
    };
    writeToken(token);
  }

  return token.access_token;
}

interface CreateFileArgs {
  name: string;
  content: string;
  folder_id?: string;
  mime_type?: string;
}

interface CreateGoogleDocArgs {
  name: string;
  content?: string;
  folder_id?: string;
}

async function createFile(args: CreateFileArgs): Promise<string> {
  const accessToken = await getAccessToken();

  const mimeType = args.mime_type || 'text/plain';
  const metadata: Record<string, unknown> = {
    name: args.name,
    mimeType,
  };
  if (args.folder_id) {
    metadata.parents = [args.folder_id];
  }

  // Use multipart upload
  const boundary = '-------NanoclawBoundary';
  const metadataPart = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const contentPart = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${args.content}\r\n--${boundary}--`;
  const body = metadataPart + contentPart;

  const resp = await httpRequest(
    'POST',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
    accessToken,
    body,
    `multipart/related; boundary="${boundary}"`,
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Drive API error ${resp.status}: ${resp.body}`);
  }

  const file = JSON.parse(resp.body);
  return `Created file "${file.name}" (ID: ${file.id})\nLink: ${file.webViewLink || `https://drive.google.com/file/d/${file.id}`}`;
}

async function createGoogleDoc(args: CreateGoogleDocArgs): Promise<string> {
  const accessToken = await getAccessToken();

  const metadata: Record<string, unknown> = {
    name: args.name,
    mimeType: 'application/vnd.google-apps.document',
  };
  if (args.folder_id) {
    metadata.parents = [args.folder_id];
  }

  // Create empty Google Doc
  const createResp = await httpRequest(
    'POST',
    'https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',
    accessToken,
    JSON.stringify(metadata),
    'application/json',
  );

  if (createResp.status < 200 || createResp.status >= 300) {
    throw new Error(`Drive API error ${createResp.status}: ${createResp.body}`);
  }

  const file = JSON.parse(createResp.body);

  // If content provided, update via Docs API
  if (args.content) {
    const requests = [{
      insertText: {
        location: { index: 1 },
        text: args.content,
      },
    }];
    const docsResp = await httpRequest(
      'POST',
      `https://docs.googleapis.com/v1/documents/${file.id}:batchUpdate`,
      accessToken,
      JSON.stringify({ requests }),
      'application/json',
    );
    if (docsResp.status < 200 || docsResp.status >= 300) {
      // Non-fatal: doc was created, just content insertion failed
      return `Created Google Doc "${file.name}" (ID: ${file.id}) but content insertion failed: ${docsResp.body}\nLink: ${file.webViewLink}`;
    }
  }

  return `Created Google Doc "${file.name}" (ID: ${file.id})\nLink: ${file.webViewLink || `https://docs.google.com/document/d/${file.id}`}`;
}

async function updateFileContent(args: { file_id: string; content: string; mime_type?: string }): Promise<string> {
  const accessToken = await getAccessToken();
  const mimeType = args.mime_type || 'text/plain';

  const resp = await httpRequest(
    'PATCH',
    `https://www.googleapis.com/upload/drive/v3/files/${args.file_id}?uploadType=media&fields=id,name`,
    accessToken,
    args.content,
    mimeType,
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Drive API error ${resp.status}: ${resp.body}`);
  }

  const file = JSON.parse(resp.body);
  return `Updated file "${file.name}" (ID: ${file.id})`;
}

async function main() {
  const server = new Server(
    { name: 'gdrive-write', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'gdrive_create_file',
        description: 'Create a new file in Google Drive with text content. Use for .txt, .md, .csv, or any plain text format.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'File name (e.g. "notes.md", "report.txt")' },
            content: { type: 'string', description: 'File content as text' },
            folder_id: { type: 'string', description: 'Google Drive folder ID to create the file in (optional)' },
            mime_type: { type: 'string', description: 'MIME type (default: text/plain). Use text/markdown for .md, text/csv for .csv' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'gdrive_create_doc',
        description: 'Create a new Google Doc (editable Google Docs format) in Drive, optionally with initial text content.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Document title' },
            content: { type: 'string', description: 'Initial text content (optional)' },
            folder_id: { type: 'string', description: 'Google Drive folder ID to create the doc in (optional)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'gdrive_update_file',
        description: 'Overwrite the content of an existing file in Google Drive (by file ID).',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'Google Drive file ID' },
            content: { type: 'string', description: 'New file content' },
            mime_type: { type: 'string', description: 'MIME type of content (default: text/plain)' },
          },
          required: ['file_id', 'content'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      if (name === 'gdrive_create_file') {
        result = await createFile(args as unknown as CreateFileArgs);
      } else if (name === 'gdrive_create_doc') {
        result = await createGoogleDoc(args as unknown as CreateGoogleDocArgs);
      } else if (name === 'gdrive_update_file') {
        result = await updateFileContent(args as unknown as { file_id: string; content: string; mime_type?: string });
      } else {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`gdrive-write-mcp fatal: ${err}\n`);
  process.exit(1);
});

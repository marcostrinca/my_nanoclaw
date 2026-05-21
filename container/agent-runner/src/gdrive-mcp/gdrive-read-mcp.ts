/**
 * Google Drive Read MCP Server
 *
 * Replacement for @isaacphi/mcp-gdrive with proper Shared Drive support.
 * All Drive API calls include includeItemsFromAllDrives=true and supportsAllDrives=true.
 * Queries are passed directly to the Drive API — no query mangling.
 *
 * Tools: gdrive_search, gdrive_read_file, gsheets_read, gsheets_update_cell
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

// ── Auth ──────────────────────────────────────────────────────────────────────

interface TokenData {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type?: string;
}

function readKeys(): { client_id: string; client_secret: string } {
  const raw = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  const creds = raw.installed || raw.web;
  if (!creds?.client_id || !creds?.client_secret) {
    throw new Error('Missing client_id or client_secret in gcp-oauth.keys.json');
  }
  return { client_id: creds.client_id, client_secret: creds.client_secret };
}

function readToken(): TokenData {
  const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
  // Accept both the mcp-gdrive format and the gcloud authorized_user format
  const refreshToken = raw.refresh_token;
  if (!refreshToken) throw new Error('No refresh_token in credentials file');
  return {
    access_token: raw.access_token || '',
    refresh_token: refreshToken,
    expiry_date: raw.expiry_date || 0,
    token_type: raw.token_type || 'Bearer',
  };
}

function writeToken(token: TokenData): void {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...token }, null, 2));
}

async function post(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(Buffer.byteLength(body)),
      },
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

async function getAccessToken(): Promise<string> {
  let token = readToken();

  const needsRefresh = !token.access_token || Date.now() >= (token.expiry_date || 0) - 60_000;
  if (needsRefresh) {
    const keys = readKeys();
    const params = new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    });
    const resp = JSON.parse(await post('https://oauth2.googleapis.com/token', params.toString()));
    if (!resp.access_token) {
      throw new Error(`Token refresh failed: ${JSON.stringify(resp)}`);
    }
    token = {
      ...token,
      access_token: resp.access_token,
      expiry_date: Date.now() + (resp.expires_in || 3600) * 1000,
    };
    writeToken(token);
  }

  return token.access_token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiGet(url: string, accessToken: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function apiPost(url: string, accessToken: string, body: string, contentType = 'application/json'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const bodyBuf = Buffer.from(body, 'utf-8');
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': contentType,
        'Content-Length': String(bodyBuf.length),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function assertOk(res: { status: number; body: string }, label: string): unknown {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${label} — HTTP ${res.status}: ${res.body}`);
  }
  return JSON.parse(res.body);
}

// ── Drive Search ──────────────────────────────────────────────────────────────

async function driveSearch(args: { query: string; pageSize?: number; pageToken?: string }): Promise<string> {
  const accessToken = await getAccessToken();

  const params = new URLSearchParams({
    q: args.query,
    pageSize: String(Math.min(args.pageSize || 20, 100)),
    orderBy: 'modifiedTime desc',
    fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, webViewLink)',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    corpora: 'allDrives',
  });
  if (args.pageToken) params.set('pageToken', args.pageToken);

  const res = await apiGet(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken);
  const data = assertOk(res, 'gdrive_search') as { files?: Array<{ id: string; name: string; mimeType: string; modifiedTime?: string }>; nextPageToken?: string };

  const files = data.files || [];
  const lines = files.map(f => `${f.id}  ${f.name}  (${f.mimeType}${f.modifiedTime ? ', ' + f.modifiedTime.slice(0, 10) : ''})`);
  let text = `Found ${files.length} file(s):\n${lines.join('\n')}`;
  if (data.nextPageToken) text += `\n\nMore results available. Use pageToken: ${data.nextPageToken}`;
  return text;
}

// ── Drive Read File ───────────────────────────────────────────────────────────

async function driveReadFile(args: { fileId: string }): Promise<string> {
  const accessToken = await getAccessToken();
  const { fileId } = args;

  // Get file metadata
  const metaParams = new URLSearchParams({
    fields: 'id,name,mimeType',
    supportsAllDrives: 'true',
  });
  const metaRes = await apiGet(`https://www.googleapis.com/drive/v3/files/${fileId}?${metaParams}`, accessToken);
  const meta = assertOk(metaRes, 'gdrive_read_file metadata') as { name: string; mimeType: string };

  const { name, mimeType } = meta;

  // Google Workspace files: export
  if (mimeType.startsWith('application/vnd.google-apps')) {
    const exportMimeTypes: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/markdown',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
      'application/vnd.google-apps.drawing': 'image/png',
    };
    const exportMime = exportMimeTypes[mimeType] || 'text/plain';
    const exportParams = new URLSearchParams({ mimeType: exportMime });
    const exportRes = await apiGet(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export?${exportParams}`,
      accessToken,
    );
    if (exportRes.status < 200 || exportRes.status >= 300) {
      throw new Error(`Export failed — HTTP ${exportRes.status}: ${exportRes.body}`);
    }
    return `Contents of ${name}:\n\n${exportRes.body}`;
  }

  // Regular files: download
  const dlParams = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
  const dlRes = await apiGet(`https://www.googleapis.com/drive/v3/files/${fileId}?${dlParams}`, accessToken);
  if (dlRes.status < 200 || dlRes.status >= 300) {
    throw new Error(`Download failed — HTTP ${dlRes.status}: ${dlRes.body}`);
  }
  return `Contents of ${name}:\n\n${dlRes.body}`;
}

// ── List Shared Drives ────────────────────────────────────────────────────────

async function listDrives(args: { nameFilter?: string }): Promise<string> {
  const accessToken = await getAccessToken();

  const params = new URLSearchParams({
    pageSize: '50',
    fields: 'nextPageToken, drives(id, name, kind)',
  });
  if (args.nameFilter) {
    params.set('q', `name contains '${args.nameFilter.replace(/'/g, "\\'")}'`);
  }

  const res = await apiGet(`https://www.googleapis.com/drive/v3/drives?${params}`, accessToken);
  const data = assertOk(res, 'gdrive_list_drives') as { drives?: Array<{ id: string; name: string }>; nextPageToken?: string };

  const drives = data.drives || [];
  if (drives.length === 0) return 'No Shared Drives found.';
  const lines = drives.map(d => `${d.id}  ${d.name}`);
  let text = `Found ${drives.length} Shared Drive(s):\n${lines.join('\n')}`;
  if (data.nextPageToken) text += `\n\nMore results available.`;
  return text;
}

// ── Sheets Read ───────────────────────────────────────────────────────────────

function getA1Notation(row: number, col: number): string {
  let a1 = '';
  let c = col;
  while (c > 0) {
    c--;
    a1 = String.fromCharCode(65 + (c % 26)) + a1;
    c = Math.floor(c / 26);
  }
  return `${a1}${row + 1}`;
}

async function sheetsRead(args: { spreadsheetId: string; ranges?: string[]; sheetId?: number }): Promise<string> {
  const accessToken = await getAccessToken();
  const { spreadsheetId } = args;
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;

  type ValueRange = { range?: string; values?: string[][] };
  type SheetResult = { data: { valueRanges?: ValueRange[]; values?: string[][]; range?: string } };

  let result: SheetResult;

  if (args.ranges && args.ranges.length > 0) {
    const params = new URLSearchParams();
    for (const r of args.ranges) params.append('ranges', r);
    const res = await apiGet(`${base}/values:batchGet?${params}`, accessToken);
    result = { data: assertOk(res, 'gsheets_read batchGet') as SheetResult['data'] };
  } else if (args.sheetId !== undefined) {
    const metaRes = await apiGet(`${base}?fields=sheets.properties`, accessToken);
    const metaData = assertOk(metaRes, 'gsheets_read metadata') as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };
    const sheet = metaData.sheets?.find(s => s.properties?.sheetId === args.sheetId);
    if (!sheet?.properties?.title) throw new Error(`Sheet ID ${args.sheetId} not found`);
    const res = await apiGet(`${base}/values/${encodeURIComponent(sheet.properties.title)}`, accessToken);
    result = { data: assertOk(res, 'gsheets_read values') as SheetResult['data'] };
  } else {
    const res = await apiGet(`${base}/values/A:ZZ`, accessToken);
    result = { data: assertOk(res, 'gsheets_read values') as SheetResult['data'] };
  }

  // Normalise to array of value ranges
  const valueRanges: ValueRange[] = result.data.valueRanges || [result.data];

  const processed = valueRanges.map((vr) => {
    const values = vr.values || [];
    const rangeParts = (vr.range || '').split('!');
    const sheetName = (rangeParts[0] || 'Sheet1').replace(/'/g, '');
    const withLocations = values.map((row, ri) =>
      row.map((cell, ci) => ({ value: cell, location: `${sheetName}!${getA1Notation(ri, ci + 1)}` })),
    );
    return {
      sheetName,
      columnHeaders: withLocations[0] || [],
      data: withLocations.slice(1),
      totalRows: values.length,
      totalColumns: withLocations[0]?.length || 0,
    };
  });

  return JSON.stringify(processed, null, 2);
}

// ── Sheets Update Cell ────────────────────────────────────────────────────────

async function sheetsUpdateCell(args: { fileId: string; range: string; value: string }): Promise<string> {
  const accessToken = await getAccessToken();
  const { fileId, range, value } = args;

  // values.update requires PUT; batchUpdate accepts POST and supports the same use case
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchUpdate`;
  const body = JSON.stringify({
    valueInputOption: 'RAW',
    data: [{ range, values: [[value]] }],
  });
  const res = await apiPost(url, accessToken, body);
  assertOk(res, 'gsheets_update_cell');
  return `Updated cell ${range} to value: ${value}`;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

async function main() {
  const server = new Server(
    { name: 'gdrive-read', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'gdrive_search',
        description: 'Search for files in Google Drive and Shared Drives. Pass a Drive API query string directly (e.g. "name = \'Report\' and mimeType = \'application/vnd.google-apps.folder\'" or "\'FOLDER_ID\' in parents"). Supports all Drive query operators.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Drive API query string. Examples: "name contains \'Budget\'", "\'FOLDER_ID\' in parents and trashed = false", "name = \'Comercial\' and mimeType = \'application/vnd.google-apps.folder\'"',
            },
            pageSize: {
              type: 'number',
              description: 'Number of results (max 100, default 20)',
            },
            pageToken: {
              type: 'string',
              description: 'Token for next page of results',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'gdrive_read_file',
        description: 'Read contents of a file from Google Drive or Shared Drive by file ID. Supports Google Docs (exported as Markdown), Sheets (exported as CSV), Presentations, and regular files.',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Google Drive file ID' },
          },
          required: ['fileId'],
        },
      },
      {
        name: 'gsheets_read',
        description: 'Read data from a Google Spreadsheet with optional range selection.',
        inputSchema: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string', description: 'Spreadsheet ID' },
            ranges: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional A1 notation ranges (e.g. ["Sheet1!A1:D10"]). Reads all columns if omitted.',
            },
            sheetId: {
              type: 'number',
              description: 'Optional sheet ID. If omitted, reads the first sheet.',
            },
          },
          required: ['spreadsheetId'],
        },
      },
      {
        name: 'gsheets_update_cell',
        description: 'Update a single cell value in a Google Spreadsheet.',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: { type: 'string', description: 'Spreadsheet ID' },
            range: { type: 'string', description: 'Cell in A1 notation (e.g. "Sheet1!B3")' },
            value: { type: 'string', description: 'New cell value' },
          },
          required: ['fileId', 'range', 'value'],
        },
      },
      {
        name: 'gdrive_list_drives',
        description: 'List Shared Drives accessible to this account. Use this to find the ID of a Shared Drive by name (e.g. "Comercial"). Shared Drives do NOT appear in gdrive_search results — use this tool first to get their ID.',
        inputSchema: {
          type: 'object',
          properties: {
            nameFilter: {
              type: 'string',
              description: 'Optional name filter (case-insensitive contains). Omit to list all Shared Drives.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let text: string;
      if (name === 'gdrive_search') {
        text = await driveSearch(args as { query: string; pageSize?: number; pageToken?: string });
      } else if (name === 'gdrive_read_file') {
        text = await driveReadFile(args as { fileId: string });
      } else if (name === 'gsheets_read') {
        text = await sheetsRead(args as { spreadsheetId: string; ranges?: string[]; sheetId?: number });
      } else if (name === 'gsheets_update_cell') {
        text = await sheetsUpdateCell(args as { fileId: string; range: string; value: string });
      } else if (name === 'gdrive_list_drives') {
        text = await listDrives(args as { nameFilter?: string });
      } else {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
      return { content: [{ type: 'text', text: text }] };
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
  process.stderr.write(`gdrive-read-mcp fatal: ${err}\n`);
  process.exit(1);
});

import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TAbstractFile,
  TFile,
  normalizePath
} from 'obsidian';

const NOTION_API = 'https://api.notion.com/v1';
const DEFAULT_NOTION_VERSION = '2025-09-03';
const SINGLE_UPLOAD_LIMIT = 20 * 1024 * 1024;
const UPLOAD_TTL_MS = 50 * 60 * 1000;
const BLOCK_APPEND_BATCH_SIZE = 20;
const WAF_SAFE_MARK = '\u200b';
const WAF_SENSITIVE_WORDS = [
  'truncate', 'execute', 'select', 'insert', 'update', 'delete', 'create',
  'script', 'union', 'where', 'alter', 'exec', 'drop', 'from', 'join'
];

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'tiff', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac']);
const PDF_EXTS = new Set(['pdf']);

const EXTRA_MIME: Record<string, string> = {
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mkv: 'video/x-matroska',
  m4v: 'video/mp4'
};

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  ...EXTRA_MIME
};

const NOTION_LANGS = new Set([
  'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++',
  'c#', 'css', 'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'f#',
  'flow', 'fortran', 'gherkin', 'glsl', 'go', 'graphql', 'groovy', 'haskell',
  'html', 'java', 'javascript', 'json', 'julia', 'kotlin', 'latex', 'less',
  'lisp', 'livescript', 'lua', 'makefile', 'markdown', 'markup', 'matlab',
  'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php',
  'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason',
  'ruby', 'rust', 'sass', 'scala', 'scheme', 'scss', 'shell', 'sql', 'swift',
  'typescript', 'vb.net', 'verilog', 'vhdl', 'visual basic', 'webassembly',
  'xml', 'yaml'
]);

interface SyncSettings {
  notionToken: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthRedirectUri: string;
  oauthCodeInput: string;
  oauthWorkspaceName: string;
  oauthBotId: string;
  parentPageId: string;
  parentPageInput: string;
  notionVersion: string;
  autoSync: boolean;
  verboseSkipped: boolean;
}

interface SyncRecord {
  hash?: string;
  pageId?: string;
  title?: string;
  attachments?: Record<string, string>;
  syncedAt?: string;
}

interface PluginData {
  settings: SyncSettings;
  syncState: Record<string, SyncRecord>;
}

interface InlineContext {
  state: Record<string, SyncRecord>;
  mdFile: TFile;
}

interface NotionRichTextText {
  type: 'text';
  text: {
    content: string;
    link?: { url: string };
  };
  annotations?: Record<string, unknown>;
}

interface NotionMentionRichText {
  type: 'mention';
  mention: {
    type: 'page';
    page: { id: string };
  };
}

type NotionRichText = NotionRichTextText | NotionMentionRichText;

interface NotionBlock {
  object: 'block';
  type: string;
  [key: string]: unknown;
}

type SyncResult = 'created' | 'updated' | 'recreated' | 'skipped';

class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly html403 = false
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

const DEFAULT_SETTINGS: SyncSettings = {
  notionToken: '',
  oauthClientId: '',
  oauthClientSecret: '',
  oauthRedirectUri: 'https://localhost/obsidian-notion-sync',
  oauthCodeInput: '',
  oauthWorkspaceName: '',
  oauthBotId: '',
  parentPageId: '',
  parentPageInput: '',
  notionVersion: DEFAULT_NOTION_VERSION,
  autoSync: false,
  verboseSkipped: true
};

class RateLimiter {
  private tokens: number;
  private lastCheck = Date.now();

  constructor(private rate = 2.8, private capacity = 3) {
    this.tokens = capacity;
  }

  async acquire() {
    const now = Date.now();
    const elapsed = (now - this.lastCheck) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastCheck = now;

    if (this.tokens < 1) {
      const sleepMs = ((1 - this.tokens) / this.rate) * 1000;
      await delay(sleepMs);
      this.tokens = 0;
      this.lastCheck = Date.now();
    } else {
      this.tokens -= 1;
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function getExt(path: string) {
  const match = /\.([^./\\]+)$/.exec(path);
  return match ? match[1].toLowerCase() : '';
}

function titleFromPath(path: string) {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

function folderPathForFile(file: TFile) {
  const path = file.parent?.path ?? '';
  return path === '/' ? '' : normalizePath(path);
}

function joinVaultPath(baseDir: string, target: string) {
  const parts = `${baseDir ? `${baseDir}/` : ''}${target}`
    .replace(/\\/g, '/')
    .split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return normalizePath(out.join('/'));
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNotionPageId(input: string) {
  const compact = input.trim().replace(/-/g, '');
  const match = compact.match(/[0-9a-fA-F]{32}/);
  return match ? match[0] : input.trim();
}

function textChunks(content: string, size = 1900) {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += size) chunks.push(content.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

function richTextNode(content: string, annotations?: Record<string, unknown>, link?: string): NotionRichTextText {
  const text: NotionRichTextText['text'] = { content };
  if (link) text.link = { url: link };
  const node: NotionRichTextText = { type: 'text', text };
  if (annotations) node.annotations = annotations;
  return node;
}

function pageMentionNode(pageId: string): NotionMentionRichText {
  return { type: 'mention', mention: { type: 'page', page: { id: pageId } } };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function arrayBufferToHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(data: ArrayBuffer | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return arrayBufferToHex(digest);
}

function concatUint8(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function buildMultipartBody(fields: Record<string, string>, fileName: string, contentType: string, data: Uint8Array) {
  const boundary = `----ObsidianNotionSync${Date.now()}${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    chunks.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    chunks.push(enc.encode(`${value}\r\n`));
  }

  chunks.push(enc.encode(`--${boundary}\r\n`));
  chunks.push(enc.encode(`Content-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, '')}"\r\n`));
  chunks.push(enc.encode(`Content-Type: ${contentType}\r\n\r\n`));
  chunks.push(data);
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

  return {
    body: concatUint8(chunks).buffer,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

export default class ObsidianNotionSyncPlugin extends Plugin {
  settings: SyncSettings = { ...DEFAULT_SETTINGS };
  syncState: Record<string, SyncRecord> = {};
  private rateLimiter = new RateLimiter();
  private uploadCache = new Map<string, { uploadId: string; uploadedAt: number }>();
  private deadPages = new Set<string>();
  private statusEl: HTMLElement | null = null;
  private syncInProgress = false;
  private debounceTimers = new Map<string, number>();

  private isInsideConfigDir(file: TFile) {
    const configDir = normalizePath(this.app.vault.configDir);
    return file.path === configDir || file.path.startsWith(`${configDir}/`);
  }

  async onload() {
    await this.loadPluginData();

    this.statusEl = this.addStatusBarItem();
    this.setStatus('Notion sync ready');

    this.addRibbonIcon('sync', 'Sync vault to Notion', () => this.syncAll(false));

    this.addCommand({
      id: 'sync-current-note-to-notion',
      name: 'Sync current note to Notion',
      callback: () => this.syncCurrentNote(false)
    });

    this.addCommand({
      id: 'sync-vault-to-notion',
      name: 'Sync entire vault to Notion',
      callback: () => this.syncAll(false)
    });

    this.addCommand({
      id: 'force-sync-vault-to-notion',
      name: 'Force resync entire vault to Notion',
      callback: () => this.syncAll(true)
    });

    this.addCommand({
      id: 'test-notion-connection',
      name: 'Test Notion connection',
      callback: () => this.testConnection()
    });

    this.addSettingTab(new NotionSyncSettingTab(this.app, this));

    if (this.settings.autoSync) {
      this.registerAutoSyncEvents();
    }
  }

  onunload() {
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
  }

  private registerAutoSyncEvents() {
    const handle = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      const oldTimer = this.debounceTimers.get(file.path);
      if (oldTimer) window.clearTimeout(oldTimer);
      const timer = window.setTimeout(() => {
        this.debounceTimers.delete(file.path);
        this.syncOneFile(file, false).catch((err) => {
          console.error(err);
          new Notice(`Notion sync error: ${errorMessage(err)}`);
        });
      }, 1500);
      this.debounceTimers.set(file.path, timer);
    };

    this.registerEvent(this.app.vault.on('modify', handle));
    this.registerEvent(this.app.vault.on('create', handle));
  }

  async loadPluginData() {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    if (this.settings.parentPageInput && !this.settings.parentPageId) {
      this.settings.parentPageId = extractNotionPageId(this.settings.parentPageInput);
    }
    this.syncState = data?.syncState ?? {};
  }

  async savePluginData() {
    await this.saveData({ settings: this.settings, syncState: this.syncState } satisfies PluginData);
  }

  private setStatus(message: string) {
    if (this.statusEl) this.statusEl.setText(`Notion: ${message}`);
  }

  private ensureConfigured() {
    if (!this.settings.notionToken.trim()) throw new Error('Notion integration token이 필요합니다.');
    if (!this.settings.parentPageId.trim()) throw new Error('Notion 부모 페이지 ID 또는 URL이 필요합니다.');
  }

  private notionHeaders(json = true) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.settings.notionToken.trim()}`,
      'Notion-Version': this.settings.notionVersion || DEFAULT_NOTION_VERSION
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private isHtml403Response(response: { status: number; headers?: Record<string, string>; text?: string }) {
    if (response.status !== 403) return false;
    const contentType = Object.entries(response.headers ?? {})
      .find(([key]) => key.toLowerCase() === 'content-type')?.[1]
      ?.toLowerCase() ?? '';
    const textHead = (response.text ?? '').slice(0, 200).toLowerCase();
    return contentType.includes('text/html') || textHead.includes('<!doctype html') || textHead.includes('cloudflare');
  }

  private isHtml403Error(error: unknown) {
    return error instanceof NotionApiError && error.html403;
  }

  private isArchivedBlockError(error: unknown) {
    if (!(error instanceof NotionApiError) || error.status !== 400) return false;
    const message = error.message.toLowerCase();
    return message.includes('archived') && (message.includes('block') || message.includes('ancestor'));
  }

  private neutralizeWafText(text: string) {
    if (!text) return text;
    const words = WAF_SENSITIVE_WORDS
      .slice()
      .sort((a, b) => b.length - a.length)
      .map((word) => escapeRegExp(word))
      .join('|');
    let safe = text.replace(new RegExp(`\\b(${words})\\b`, 'gi'), (word) => {
      if (word.includes(WAF_SAFE_MARK) || word.length < 2) return word;
      return `${word[0]}${WAF_SAFE_MARK}${word.slice(1)}`;
    });
    safe = safe.replace(/<\s*\/?\s*script\b/gi, (match) => match.replace(/script/i, `s${WAF_SAFE_MARK}cript`));
    safe = safe.replace(/javascript\s*:/gi, `j${WAF_SAFE_MARK}avascript:`);
    return safe;
  }

  private makeWafSafeBlock(block: NotionBlock) {
    let changed = false;
    const safe = JSON.parse(JSON.stringify(block)) as NotionBlock;

    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      const text = asObject(node.text);
      const content = asString(text.content);
      if (node.type === 'text' && content !== undefined) {
        const next = this.neutralizeWafText(content);
        if (next !== content) {
          text.content = next;
          changed = true;
        }
      }
      Object.values(node).forEach(visit);
    };

    visit(safe);
    return changed ? safe : block;
  }

  private async apiRequest(method: string, pathOrUrl: string, body?: unknown, headers?: Record<string, string>, contentType?: string) {
    this.ensureConfigured();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${NOTION_API}${pathOrUrl}`;
    const maxRetries = 5;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.rateLimiter.acquire();
      const response = await requestUrl({
        url,
        method,
        headers: headers ?? this.notionHeaders(body !== undefined),
        body: body instanceof ArrayBuffer ? body : body === undefined ? undefined : JSON.stringify(body),
        contentType
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers?.['Retry-After'] ?? 2 ** attempt);
        this.setStatus(`rate limit, ${retryAfter}s wait`);
        await delay(retryAfter * 1000);
        continue;
      }

      if (response.status >= 500 && attempt < maxRetries - 1) {
        await delay((2 ** attempt) * 1000);
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        if (this.isHtml403Response(response)) {
          throw new NotionApiError(
            `Notion API 403: Cloudflare/WAF HTML 차단 응답 (${method} ${url})`,
            response.status,
            true
          );
        }
        const responseJson = asObject(response.json);
        const message = asString(responseJson.message) ?? response.text ?? `HTTP ${response.status}`;
        throw new NotionApiError(`Notion API ${response.status}: ${message}`, response.status);
      }

      return response;
    }

    throw new Error(`Rate limit retry exceeded: ${method} ${url}`);
  }

  async testConnection() {
    try {
      this.settings.parentPageId = extractNotionPageId(this.settings.parentPageInput || this.settings.parentPageId);
      await this.savePluginData();
      await this.apiRequest('GET', `/pages/${this.settings.parentPageId}`);
      new Notice('Notion 연결 성공');
    } catch (err) {
      new Notice(`Notion 연결 실패: ${errorMessage(err)}`);
    }
  }

  private buildOAuthAuthorizeUrl() {
    const clientId = this.settings.oauthClientId.trim();
    const redirectUri = this.settings.oauthRedirectUri.trim();
    if (!clientId) throw new Error('Notion OAuth client ID가 필요합니다.');
    if (!redirectUri) throw new Error('Notion OAuth redirect URI가 필요합니다.');
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      owner: 'user',
      redirect_uri: redirectUri
    });
    return `${NOTION_API}/oauth/authorize?${params.toString()}`;
  }

  openNotionOAuth() {
    try {
      const url = this.buildOAuthAuthorizeUrl();
      window.open(url, '_blank');
      new Notice('브라우저에서 Notion 권한 승인 후 redirect URL 전체를 복사해 붙여넣으세요.');
    } catch (err) {
      new Notice(`OAuth URL 생성 실패: ${errorMessage(err)}`);
    }
  }

  private extractOAuthCode(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      return parsed.searchParams.get('code') ?? trimmed;
    } catch {
      const match = trimmed.match(/[?&]code=([^&]+)/);
      return match ? decodeURIComponent(match[1]) : trimmed;
    }
  }

  async exchangeOAuthCode() {
    try {
      const clientId = this.settings.oauthClientId.trim();
      const clientSecret = this.settings.oauthClientSecret.trim();
      const redirectUri = this.settings.oauthRedirectUri.trim();
      const code = this.extractOAuthCode(this.settings.oauthCodeInput);
      if (!clientId) throw new Error('Notion OAuth client ID가 필요합니다.');
      if (!clientSecret) throw new Error('Notion OAuth client secret이 필요합니다.');
      if (!redirectUri) throw new Error('Notion OAuth redirect URI가 필요합니다.');
      if (!code) throw new Error('OAuth redirect URL 또는 code가 필요합니다.');

      const response = await requestUrl({
        url: `${NOTION_API}/oauth/token`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        })
      });

      if (response.status < 200 || response.status >= 300) {
        const responseJson = asObject(response.json);
        const message = asString(responseJson.error_description) ?? asString(responseJson.message) ?? response.text ?? `HTTP ${response.status}`;
        throw new Error(message);
      }

      const responseJson = asObject(response.json);
      this.settings.notionToken = asString(responseJson.access_token) ?? '';
      this.settings.oauthWorkspaceName = asString(responseJson.workspace_name) ?? '';
      this.settings.oauthBotId = asString(responseJson.bot_id) ?? '';
      this.settings.oauthCodeInput = '';
      await this.savePluginData();
      new Notice(`Notion OAuth 연결 성공${this.settings.oauthWorkspaceName ? `: ${this.settings.oauthWorkspaceName}` : ''}`);
    } catch (err) {
      new Notice(`OAuth 토큰 교환 실패: ${errorMessage(err)}`);
    }
  }

  async disconnectOAuth() {
    this.settings.notionToken = '';
    this.settings.oauthWorkspaceName = '';
    this.settings.oauthBotId = '';
    await this.savePluginData();
    new Notice('Notion OAUTH 토큰을 삭제했습니다.');
  }

  private getMarkdownFiles() {
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => !this.isInsideConfigDir(file))
      .sort((a, b) => a.path.localeCompare(b.path, 'ko'));
  }

  private async fileHash(file: TFile) {
    return sha256(await this.app.vault.readBinary(file));
  }

  private async textHash(file: TFile) {
    return sha256(await this.app.vault.read(file));
  }

  private blockTypeForPath(path: string) {
    const ext = getExt(path);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (PDF_EXTS.has(ext)) return 'pdf';
    return 'file';
  }

  private contentTypeForPath(path: string) {
    const ext = getExt(path);
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
  }

  private resolveLocalFile(ref: string, mdFile: TFile) {
    const cleaned = safeDecode(ref.trim()).replace(/^<|>$/g, '').split('?')[0].split('#')[0];
    if (!cleaned || /^(https?:|mailto:|#)/i.test(cleaned)) return null;

    const candidates = [
      joinVaultPath(folderPathForFile(mdFile), cleaned),
      normalizePath(cleaned.replace(/^\//, ''))
    ];

    for (const candidate of candidates) {
      const found = this.app.vault.getAbstractFileByPath(candidate);
      if (found instanceof TFile) return found;
    }

    const fileName = cleaned.split('/').pop()?.toLowerCase();
    if (!fileName) return null;
    return this.app.vault
      .getFiles()
      .find((file) => file instanceof TFile && !this.isInsideConfigDir(file) && file.name.toLowerCase() === fileName) ?? null;
  }

  private async uploadFileToNotion(file: TFile) {
    const data = await this.app.vault.readBinary(file);
    const contentHash = await sha256(data);
    const cached = this.uploadCache.get(contentHash);
    if (cached && Date.now() - cached.uploadedAt < UPLOAD_TTL_MS) return cached.uploadId;

    const fileSize = data.byteLength;
    const contentType = this.contentTypeForPath(file.path);
    const createPayload: Record<string, unknown> = fileSize <= SINGLE_UPLOAD_LIMIT
      ? { filename: file.name, content_type: contentType }
      : {
          mode: 'multi_part',
          number_of_parts: Math.ceil(fileSize / SINGLE_UPLOAD_LIMIT),
          filename: file.name,
          content_type: contentType
        };

    const createResponse = await this.apiRequest('POST', '/file_uploads', createPayload);
    const fileUploadId = asString(asObject(createResponse.json).id);
    if (!fileUploadId) throw new Error('Notion file upload ID가 응답에 없습니다.');
    const sendHeaders = this.notionHeaders(false);

    if (fileSize <= SINGLE_UPLOAD_LIMIT) {
      const multipart = buildMultipartBody({}, file.name, contentType, new Uint8Array(data));
      await this.apiRequest(
        'POST',
        `/file_uploads/${fileUploadId}/send`,
        multipart.body,
        sendHeaders,
        multipart.contentType
      );
    } else {
      const totalParts = Math.ceil(fileSize / SINGLE_UPLOAD_LIMIT);
      const bytes = new Uint8Array(data);
      for (let part = 1; part <= totalParts; part++) {
        const start = (part - 1) * SINGLE_UPLOAD_LIMIT;
        const end = Math.min(start + SINGLE_UPLOAD_LIMIT, fileSize);
        const multipart = buildMultipartBody(
          { part_number: String(part) },
          file.name,
          contentType,
          bytes.slice(start, end)
        );
        await this.apiRequest(
          'POST',
          `/file_uploads/${fileUploadId}/send`,
          multipart.body,
          sendHeaders,
          multipart.contentType
        );
      }
      await this.apiRequest('POST', `/file_uploads/${fileUploadId}/complete`, {});
    }

    this.uploadCache.set(contentHash, { uploadId: fileUploadId, uploadedAt: Date.now() });
    return fileUploadId;
  }

  private async makeFileBlock(ref: string, mdFile: TFile, caption = '', ctx?: InlineContext): Promise<NotionBlock> {
    if (/^https?:\/\//i.test(ref)) {
      const blockType = this.blockTypeForPath(ref);
      const payload: Record<string, unknown> = { type: 'external', external: { url: ref } };
      if (caption) payload.caption = await this.parseInline(caption, ctx);
      return { object: 'block', type: blockType, [blockType]: payload } as NotionBlock;
    }

    const localFile = this.resolveLocalFile(ref, mdFile);
    if (!localFile) return this.block('paragraph', `⚠️ 파일 누락: ${ref}`, ctx);

    try {
      const uploadId = await this.uploadFileToNotion(localFile);
      const blockType = this.blockTypeForPath(localFile.path);
      const payload: Record<string, unknown> = { type: 'file_upload', file_upload: { id: uploadId } };
      if (caption) payload.caption = await this.parseInline(caption, ctx);
      return { object: 'block', type: blockType, [blockType]: payload } as NotionBlock;
    } catch (err) {
      return this.block('paragraph', `⚠️ 파일 업로드 실패 (${ref}): ${errorMessage(err)}`, ctx);
    }
  }

  private normalizePageLinkTarget(target: string) {
    return safeDecode(target)
      .trim()
      .replace(/\\/g, '/')
      .split('#', 1)[0]
      .split('^', 1)[0]
      .trim();
  }

  private async isNotionPageAlive(pageId: string) {
    if (this.deadPages.has(pageId)) return false;
    try {
      const response = await this.apiRequest('GET', `/pages/${pageId}`);
      const data = asObject(response.json);
      const alive = data.archived !== true && data.in_trash !== true;
      if (!alive) this.deadPages.add(pageId);
      return alive;
    } catch {
      this.deadPages.add(pageId);
      return false;
    }
  }

  private async livePageIdFromState(key: string) {
    const record = this.syncState[key];
    const pageId = record?.pageId;
    if (!pageId) return null;
    if (this.deadPages.has(pageId)) {
      delete record.pageId;
      return null;
    }
    if (await this.isNotionPageAlive(pageId)) return pageId;
    delete record.pageId;
    return null;
  }

  private async findPageIdByName(target: string, mdFile: TFile) {
    const normalized = this.normalizePageLinkTarget(target);
    if (!normalized) return null;
    const name = normalized.toLowerCase().endsWith('.md') ? normalized : `${normalized}.md`;

    const candidates = [
      joinVaultPath(folderPathForFile(mdFile), name),
      normalizePath(name.replace(/^\//, ''))
    ];

    for (const candidate of candidates) {
      const pageId = await this.livePageIdFromState(candidate);
      if (pageId) return pageId;
    }

    const nameLower = name.split('/').pop()?.toLowerCase();
    if (!nameLower) return null;
    for (const [key, record] of Object.entries(this.syncState)) {
      if (key.startsWith('__folder__/')) continue;
      if (key.split('/').pop()?.toLowerCase() === nameLower && record.pageId) {
        const pageId = await this.livePageIdFromState(key);
        if (pageId) return pageId;
      }
    }
    return null;
  }

  private async parseInline(text: string, ctx?: InlineContext): Promise<NotionRichText[]> {
    if (!text) return [];
    const pattern = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|`[^`\n]+`|\[\[[^\]\n]+\]\]|!\[[^\]]*\]\([^\n)]+\)|\[[^\]\n]+\]\([^\n)]+\))/g;
    const parts = text.split(pattern).filter(Boolean);
    const rich: NotionRichText[] = [];

    for (const part of parts) {
      let annotations: Record<string, unknown> | undefined;
      let link: string | undefined;
      let content = part;

      if (part.startsWith('**') && part.endsWith('**')) {
        content = part.slice(2, -2);
        annotations = { bold: true };
      } else if (part.startsWith('~~') && part.endsWith('~~')) {
        content = part.slice(2, -2);
        annotations = { strikethrough: true };
      } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
        content = part.slice(1, -1);
        annotations = { italic: true };
      } else if (part.startsWith('`') && part.endsWith('`')) {
        content = part.slice(1, -1);
        annotations = { code: true };
      } else if (part.startsWith('[[') && part.endsWith(']]')) {
        const inner = part.slice(2, -2);
        const pieces = inner.split('|');
        const target = pieces[0].trim();
        const display = pieces[pieces.length - 1].trim();
        const pageId = ctx ? await this.findPageIdByName(target, ctx.mdFile) : null;
        if (pageId) {
          rich.push(pageMentionNode(pageId));
          continue;
        }
        content = display;
        annotations = { underline: true, color: 'blue' };
      } else if (part.startsWith('![')) {
        const match = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
        if (match) content = match[1] || match[2];
      } else if (part.startsWith('[') && part.includes('](')) {
        const match = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (match) {
          content = match[1];
          const url = match[2].trim();
          if (!/^(https?:\/\/|#|mailto:)/i.test(url)) {
            const pageId = ctx ? await this.findPageIdByName(url, ctx.mdFile) : null;
            if (pageId) {
              rich.push(pageMentionNode(pageId));
              continue;
            }
          } else if (/^(https?:\/\/|mailto:)/i.test(url)) {
            link = url;
          }
        }
      }

      for (const chunk of textChunks(content)) rich.push(richTextNode(chunk, annotations, link));
    }
    return rich;
  }

  private async block(type: string, text?: string, ctx?: InlineContext, extra: Record<string, unknown> = {}): Promise<NotionBlock> {
    const payload: NotionBlock = { object: 'block', type, [type]: {} };
    const blockBody = payload[type] as Record<string, unknown>;
    if (text !== undefined) {
      const rich = await this.parseInline(text, ctx);
      blockBody.rich_text = rich.length ? rich : [richTextNode('')];
    }
    Object.assign(blockBody, extra);
    return payload;
  }

  private async parseMarkdown(markdown: string, mdFile: TFile): Promise<NotionBlock[]> {
    const ctx: InlineContext = { state: this.syncState, mdFile };
    let md = markdown;
    if (md.startsWith('---\n')) {
      const end = md.indexOf('\n---\n', 4);
      if (end !== -1) md = md.slice(end + 5);
    }

    const blocks: NotionBlock[] = [];
    const lines = md.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const stripped = line.trim();

      if (stripped.startsWith('```')) {
        let lang = stripped.slice(3).trim().toLowerCase() || 'plain text';
        if (!NOTION_LANGS.has(lang)) lang = 'plain text';
        const code: string[] = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          code.push(lines[i]);
          i += 1;
        }
        blocks.push({
          object: 'block',
          type: 'code',
          code: {
            rich_text: [richTextNode(code.join('\n').slice(0, 2000))],
            language: lang
          }
        });
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)/);
      if (heading) {
        const level = Math.min(heading[1].length, 3);
        blocks.push(await this.block(`heading_${level}`, heading[2], ctx));
        i += 1;
        continue;
      }

      if (['---', '***', '___'].includes(stripped)) {
        blocks.push({ object: 'block', type: 'divider', divider: {} });
        i += 1;
        continue;
      }

      if (stripped.startsWith('> ')) {
        blocks.push(await this.block('quote', stripped.slice(2), ctx));
        i += 1;
        continue;
      }

      const todo = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/);
      if (todo) {
        blocks.push(await this.block('to_do', todo[2], ctx, { checked: todo[1].toLowerCase() === 'x' }));
        i += 1;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        blocks.push(await this.block('bulleted_list_item', line.replace(/^\s*[-*]\s+/, ''), ctx));
        i += 1;
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        blocks.push(await this.block('numbered_list_item', line.replace(/^\s*\d+\.\s+/, ''), ctx));
        i += 1;
        continue;
      }

      let match = stripped.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      if (match) {
        blocks.push(await this.makeFileBlock(match[2].trim(), mdFile, match[1].trim(), ctx));
        i += 1;
        continue;
      }

      match = stripped.match(/^!\[\[([^\]]+)\]\]$/);
      if (match) {
        const parts = match[1].split('|');
        blocks.push(await this.makeFileBlock(parts[0].trim(), mdFile, parts[1]?.trim() ?? '', ctx));
        i += 1;
        continue;
      }

      match = stripped.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (match) {
        const ref = match[2].trim();
        const ext = getExt(ref);
        const isLocalFile = !/^(https?:\/\/|#|mailto:)/i.test(ref)
          && (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext) || PDF_EXTS.has(ext));
        if (isLocalFile) {
          blocks.push(await this.makeFileBlock(ref, mdFile, match[1], ctx));
          i += 1;
          continue;
        }
      }

      if (!stripped) {
        i += 1;
        continue;
      }

      const paraLines = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() && !this.isSpecialLine(lines[j])) {
        paraLines.push(lines[j]);
        j += 1;
      }
      blocks.push(await this.block('paragraph', paraLines.join(' ').slice(0, 2000), ctx));
      i = j;
    }

    return blocks;
  }

  private isSpecialLine(line: string) {
    const s = line.trim();
    return s.startsWith('#') || s.startsWith('- ') || s.startsWith('* ')
      || s.startsWith('> ') || s.startsWith('```')
      || ['---', '***', '___'].includes(s)
      || /^\d+\.\s/.test(s);
  }

  private async createPage(title: string, parentId: string, blocks: NotionBlock[] = []) {
    const payload: Record<string, unknown> = {
      parent: { page_id: parentId },
      properties: { title: { title: [richTextNode(title.slice(0, 2000))] } }
    };

    const response = await this.apiRequest('POST', '/pages', payload);
    const pageId = asString(asObject(response.json).id);
    if (!pageId) throw new Error('Notion page ID가 응답에 없습니다.');
    await this.appendBlocks(pageId, blocks);
    return pageId;
  }

  private async appendBlocksRaw(pageId: string, blocks: NotionBlock[]) {
    await this.apiRequest('PATCH', `/blocks/${pageId}/children`, { children: blocks });
  }

  private async appendBlocks(pageId: string, blocks: NotionBlock[]) {
    if (!blocks.length) return;

    for (let i = 0; i < blocks.length; i += BLOCK_APPEND_BATCH_SIZE) {
      const batch = blocks.slice(i, i + BLOCK_APPEND_BATCH_SIZE);
      try {
        await this.appendBlocksRaw(pageId, batch);
      } catch (err) {
        if (!this.isHtml403Error(err)) throw err;

        if (batch.length > 1) {
          console.warn(`Notion 403 WAF block detected; retrying ${batch.length} blocks one-by-one`);
          for (const block of batch) await this.appendBlocks(pageId, [block]);
          continue;
        }

        const safeBlock = this.makeWafSafeBlock(batch[0]);
        if (JSON.stringify(safeBlock) === JSON.stringify(batch[0])) throw err;
        console.warn('Notion 403 WAF block detected; retrying with WAF-safe text variant');
        await this.appendBlocksRaw(pageId, [safeBlock]);
      }
    }
  }

  private async clearBlocks(pageId: string) {
    let cursor: string | undefined;
    while (true) {
      const query = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100';
      const response = await this.apiRequest('GET', `/blocks/${pageId}/children${query}`);
      const responseJson = asObject(response.json);
      for (const value of asArray(responseJson.results)) {
        const block = asObject(value);
        if (block.archived === true || block.in_trash === true) continue;
        const blockId = asString(block.id);
        if (!blockId) continue;
        try {
          await this.apiRequest('DELETE', `/blocks/${blockId}`);
        } catch (err) {
          if (this.isArchivedBlockError(err)) continue;
          throw err;
        }
      }
      if (responseJson.has_more !== true) break;
      cursor = asString(responseJson.next_cursor);
    }
  }

  private async updatePage(pageId: string, blocks: NotionBlock[]) {
    await this.clearBlocks(pageId);
    await this.appendBlocks(pageId, blocks);
  }

  private async getOrCreateFolderPage(folderPath: string) {
    if (!folderPath) return this.settings.parentPageId;
    const normalized = normalizePath(folderPath);
    const folderKey = `__folder__/${normalized}`;
    const existing = this.syncState[folderKey]?.pageId;
    if (existing && await this.isNotionPageAlive(existing)) return existing;
    if (existing) delete this.syncState[folderKey];

    const parts = normalized.split('/').filter(Boolean);
    const parentPath = parts.slice(0, -1).join('/');
    const parentId = parentPath ? await this.getOrCreateFolderPage(parentPath) : this.settings.parentPageId;
    const pageId = await this.createPage(parts[parts.length - 1], parentId, []);
    this.syncState[folderKey] = { pageId, title: parts[parts.length - 1], syncedAt: nowIso() };
    return pageId;
  }

  private async parentIdForFile(file: TFile) {
    return this.getOrCreateFolderPage(folderPathForFile(file));
  }

  private async ensureMarkdownPage(file: TFile, parentId: string) {
    const record = this.syncState[file.path] ?? {};
    if (record.pageId && await this.isNotionPageAlive(record.pageId)) return false;
    if (record.pageId) this.deadPages.add(record.pageId);

    const pageId = await this.createPage(titleFromPath(file.path), parentId, []);
    delete record.hash;
    delete record.attachments;
    record.pageId = pageId;
    record.title = titleFromPath(file.path);
    record.syncedAt = nowIso();
    this.syncState[file.path] = record;
    return true;
  }

  private async extractReferencedFiles(markdown: string, mdFile: TFile) {
    const patterns = [
      /!\[[^\]]*\]\(([^)]+)\)/g,
      /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g,
      /^\s*\[[^\]]+\]\(([^)]+)\)\s*$/gm
    ];
    const refs = new Set<string>();
    for (const pattern of patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const ref = match[1].trim();
        if (/^(https?:\/\/|#|mailto:)/i.test(ref)) continue;
        if (pattern === patterns[2]) {
          const ext = getExt(ref);
          if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext) && !PDF_EXTS.has(ext)) continue;
        }
        refs.add(ref);
      }
    }

    const resolved: Record<string, string> = {};
    for (const ref of refs) {
      const file = this.resolveLocalFile(ref, mdFile);
      if (file) resolved[file.path] = await this.fileHash(file);
    }
    return resolved;
  }

  private async syncOneFile(file: TFile, force: boolean) {
    this.ensureConfigured();
    const parentId = await this.parentIdForFile(file);
    return this.syncFile(file, parentId, force);
  }

  private async syncFile(file: TFile, parentId: string, force: boolean) {
    const mdText = await this.app.vault.read(file);
    const mdHash = await sha256(mdText);
    const currentAttachments = await this.extractReferencedFiles(mdText, file);
    const record = this.syncState[file.path] ?? {};
    const mdUnchanged = record.hash === mdHash;
    const attachmentsUnchanged = JSON.stringify(record.attachments ?? {}) === JSON.stringify(currentAttachments);

    if (!force && mdUnchanged && attachmentsUnchanged && record.pageId) {
      if (await this.isNotionPageAlive(record.pageId)) return 'skipped';
      delete record.pageId;
      this.syncState[file.path] = record;
    }

    const blocks = await this.parseMarkdown(mdText, file);
    let pageId: string;
    let action: 'created' | 'updated' | 'recreated';

    try {
      if (record.pageId) {
        await this.updatePage(record.pageId, blocks);
        pageId = record.pageId;
        action = 'updated';
      } else {
        pageId = await this.createPage(titleFromPath(file.path), parentId, blocks);
        action = 'created';
      }
    } catch (err) {
      if (record.pageId) {
        this.deadPages.add(record.pageId);
        pageId = await this.createPage(titleFromPath(file.path), parentId, blocks);
        action = 'recreated';
      } else {
        throw err;
      }
    }

    this.syncState[file.path] = {
      hash: mdHash,
      pageId,
      title: titleFromPath(file.path),
      attachments: currentAttachments,
      syncedAt: nowIso()
    };
    return action;
  }

  async syncCurrentNote(force: boolean) {
    if (this.syncInProgress) return new Notice('이미 동기화 중입니다.');
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return new Notice('현재 활성 Markdown 파일이 없습니다.');

    try {
      this.syncInProgress = true;
      this.setStatus(`sync ${file.name}`);
      const parentId = await this.parentIdForFile(file);
      await this.ensureMarkdownPage(file, parentId);
      const action = await this.syncFile(file, parentId, force);
      await this.savePluginData();
      new Notice(`Notion ${action}: ${file.path}`);
    } catch (err) {
      console.error(err);
      new Notice(`Notion sync error: ${errorMessage(err)}`);
    } finally {
      this.syncInProgress = false;
      this.setStatus('ready');
    }
  }

  async syncAll(force: boolean) {
    if (this.syncInProgress) return new Notice('이미 동기화 중입니다.');

    try {
      this.ensureConfigured();
      this.syncInProgress = true;
      const files = this.getMarkdownFiles();
      new Notice(`Notion sync 시작: ${files.length}개 파일`);
      this.setStatus(`precheck 0/${files.length}`);

      let createdPlaceholders = 0;
      const parentCache = new Map<string, string>();
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const folder = folderPathForFile(file);
        let parentId = parentCache.get(folder);
        if (!parentId) {
          parentId = await this.getOrCreateFolderPage(folder);
          parentCache.set(folder, parentId);
        }
        if (await this.ensureMarkdownPage(file, parentId)) createdPlaceholders += 1;
        if ((i + 1) % 10 === 0) this.setStatus(`precheck ${i + 1}/${files.length}`);
        if ((i + 1) % 20 === 0) await this.savePluginData();
      }

      const forceUpdate = force || createdPlaceholders > 0;
      const counts: Record<SyncResult | 'error', number> = { created: 0, updated: 0, recreated: 0, skipped: 0, error: 0 };

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const prefix = `${i + 1}/${files.length}`;
        this.setStatus(`sync ${prefix}`);
        try {
          const parentId = parentCache.get(folderPathForFile(file)) ?? await this.parentIdForFile(file);
          const action = await this.syncFile(file, parentId, forceUpdate);
          counts[action] += 1;
          if (action !== 'skipped' || this.settings.verboseSkipped) console.debug(`[${prefix}] [${action}] ${file.path}`);
        } catch (err) {
          counts.error += 1;
          console.error(`[${prefix}] [error] ${file.path}`, err);
        }
        if ((i + 1) % 5 === 0) await this.savePluginData();
      }

      await this.savePluginData();
      const summary = `완료: 생성 ${counts.created}, 갱신 ${counts.updated}, 재생성 ${counts.recreated}, 변경없음 ${counts.skipped}, 오류 ${counts.error}`;
      this.setStatus('ready');
      new Notice(summary, 8000);
      console.debug(`Notion sync ${summary}`);
    } catch (err) {
      console.error(err);
      new Notice(`Notion sync error: ${errorMessage(err)}`);
      this.setStatus('error');
    } finally {
      this.syncInProgress = false;
    }
  }
}

class NotionSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianNotionSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Connection').setHeading();

    new Setting(containerEl).setName('Notion OAUTH').setHeading();

    new Setting(containerEl)
      .setName('OAUTH client ID')
      .setDesc('Notion public integration의 OAUTH client ID입니다.')
      .addText((text) => text
        .setPlaceholder('Client ID')
        .setValue(this.plugin.settings.oauthClientId)
        .onChange(async (value) => {
          this.plugin.settings.oauthClientId = value.trim();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('OAUTH client secret')
      .setDesc('개인용 플러그인에서는 설정에 저장됩니다. 공개 배포 시에는 백엔드 프록시가 필요합니다.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Client secret')
          .setValue(this.plugin.settings.oauthClientSecret)
          .onChange(async (value) => {
            this.plugin.settings.oauthClientSecret = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName('OAUTH redirect uri')
      .setDesc('Notion integration 설정에 등록한 redirect uri와 정확히 같아야 합니다.')
      .addText((text) => text
        .setPlaceholder('Enter redirect URL')
        .setValue(this.plugin.settings.oauthRedirectUri)
        .onChange(async (value) => {
          this.plugin.settings.oauthRedirectUri = value.trim();
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Connect with Notion')
      .setDesc('브라우저에서 권한을 승인합니다. 승인 후 열린 redirect URL 전체를 아래 입력칸에 붙여넣으세요.')
      .addButton((button) => button
        .setButtonText('Open Notion OAUTH')
        .setCta()
        .onClick(() => this.plugin.openNotionOAuth()));

    new Setting(containerEl)
      .setName('OAUTH redirect URL or code')
      .setDesc('승인 후 브라우저 주소창의 전체 URL 또는 code 값만 붙여넣고 exchange를 누릅니다.')
      .addText((text) => text
        .setPlaceholder('Enter redirect URL or code')
        .setValue(this.plugin.settings.oauthCodeInput)
        .onChange(async (value) => {
          this.plugin.settings.oauthCodeInput = value.trim();
          await this.plugin.savePluginData();
        }))
      .addButton((button) => button
        .setButtonText('Exchange')
        .onClick(() => this.plugin.exchangeOAuthCode()));

    new Setting(containerEl)
      .setName('OAUTH connection')
      .setDesc(this.plugin.settings.notionToken
        ? `연결됨${this.plugin.settings.oauthWorkspaceName ? `: ${this.plugin.settings.oauthWorkspaceName}` : ''}`
        : '아직 연결되지 않았습니다.')
      .addButton((button) => button
        .setButtonText('Disconnect')
        .onClick(() => this.plugin.disconnectOAuth()));

    new Setting(containerEl).setName('Manual token fallback').setHeading();

    new Setting(containerEl)
      .setName('Notion integration token')
      .setDesc('OAUTH를 사용하지 않을 때만 내부 통합 토큰을 직접 입력합니다.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Enter token')
          .setValue(this.plugin.settings.notionToken)
          .onChange(async (value) => {
            this.plugin.settings.notionToken = value.trim();
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName('Notion parent page URL or ID')
      .setDesc('부모 페이지 URL을 붙여넣으면 32자리 page ID를 자동 추출합니다.')
      .addText((text) => text
        .setPlaceholder('Enter parent page URL or ID')
        .setValue(this.plugin.settings.parentPageInput || this.plugin.settings.parentPageId)
        .onChange(async (value) => {
          this.plugin.settings.parentPageInput = value.trim();
          this.plugin.settings.parentPageId = extractNotionPageId(value);
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Notion API version')
      .setDesc('File uploads API를 사용하는 버전입니다. 보통 변경하지 마세요.')
      .addText((text) => text
        .setValue(this.plugin.settings.notionVersion)
        .onChange(async (value) => {
          this.plugin.settings.notionVersion = value.trim() || DEFAULT_NOTION_VERSION;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Auto sync changed notes')
      .setDesc('Obsidian에서 Markdown 파일이 변경되면 자동으로 해당 파일을 동기화합니다. 설정 변경 후 플러그인을 재로드해야 적용됩니다.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.autoSync)
        .onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Show skipped files in console')
      .setDesc('전체 동기화 중 변경 없는 파일도 콘솔에 출력합니다.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.verboseSkipped)
        .onChange(async (value) => {
          this.plugin.settings.verboseSkipped = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName('Actions')
      .addButton((button) => button
        .setButtonText('Test connection')
        .onClick(() => this.plugin.testConnection()))
      .addButton((button) => button
        .setButtonText('Sync now')
        .setCta()
        .onClick(() => this.plugin.syncAll(false)))
      .addButton((button) => button
        .setButtonText('Force sync')
        .onClick(() => this.plugin.syncAll(true)));

    const status = containerEl.createDiv({ cls: 'obsidian-notion-sync-status' });
    status.setText(`현재 vault 경로는 Obsidian이 자동 관리하므로 별도 입력이 필요 없습니다. 저장된 state 항목: ${Object.keys(this.plugin.syncState).length}개`);
  }
}

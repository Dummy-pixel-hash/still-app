// Standalone, read-only native-cache export. Node.js 18+, no npm dependencies.
// Nothing is uploaded, resumed, deleted or written inside Still's library.
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_FILE = 128 * 1024 * 1024;
const MAX_LIBRARY = 512 * 1024 * 1024;
const MAX_EXPORT = 128 * 1024 * 1024;
const MAX_FILES = 4096;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit = 4096) => typeof value === 'string' && value.length <= limit && !/\p{Cc}/u.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalJson = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

function fail(message) { throw new Error(message); }
function stamp(info) { return [info.dev, info.ino, info.size, info.mtimeNs].map(String).join(':'); }
function ordinary(path, directory = false) {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) fail('Library and export inputs must be ordinary files/directories, not symbolic links.');
  return info;
}
function readStable(path, expected) {
  const before = ordinary(path);
  if (before.size > BigInt(MAX_FILE)) fail('A journal exceeds the 128 MiB safety limit; keep the original and request a bounded recovery.');
  if (expected && stamp(before) !== expected) fail('The Windows library changed. Quit Still normally and retry; originals were not changed.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || stamp(opened) !== stamp(before)) fail('A library file changed while opening it.');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    const bytes = buffer.subarray(0, length);
    if (bytes.length !== Number(before.size) || stamp(fstatSync(fd, { bigint: true })) !== stamp(before)
        || stamp(ordinary(path)) !== stamp(before)) fail('The Windows library changed while reading it. Quit Still normally and retry.');
    return { bytes, stamp: stamp(before), sha256: digest(bytes) };
  } finally { closeSync(fd); }
}

export function parseAccount(value) {
  let parts;
  try { parts = JSON.parse(value); } catch { fail('The conversation has no supported SSH account identity.'); }
  if (!Array.isArray(parts) || parts.length !== 3 || !text(parts[0], 255) || !parts[0].trim()
      || !Number.isInteger(parts[1]) || parts[1] < 1 || parts[1] > 65535 || !text(parts[2], 128) || !parts[2]) fail('The conversation has no supported SSH account identity.');
  const [host, port, username] = parts;
  return { host: host.toLowerCase(), port, username, hostKey: JSON.stringify([host.toLowerCase(), port, username]) };
}

function journalId(name) {
  if (!/^(?:[a-f0-9]{2})+\.jsonl$/.test(name)) return null;
  const hex = name.slice(0, -6), bytes = Buffer.from(hex, 'hex'), id = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(id)) || !id || bytes.length > 100 || /\p{Cc}/u.test(id)) fail('A native journal filename has an invalid conversation identity.');
  return id;
}

/** Match native Record replay, retaining execution references even across resumes.
 * Historical requests are reduced to summaries; no pending actions are restored. */
export function replayJournal(bytes, includeHistory = false) {
  const end = bytes.lastIndexOf(10) + 1;
  const complete = bytes.subarray(0, end), decoded = complete.toString('utf8');
  if (!complete.equals(Buffer.from(decoded))) fail('The journal contains invalid UTF-8; the original was kept.');
  let row, records = 0;
  const references = new Map();
  const referenceEvent = event => {
    if (typeof event?.attemptId === 'string' && event.attemptId && !references.has(event.attemptId)) {
      references.set(event.attemptId, { executionId: event.attemptId, evidence: 'transcriptReference' });
    }
  };
  const observe = () => {
    if (typeof row?.executionId !== 'string' || !row.executionId) return;
    const reference = pick(row, ['executionId', 'agentId', 'cwd', 'agentSessionId', 'hostKey']);
    const previous = references.get(row.executionId);
    const scope = { ...pick(row, ['conversationId', 'hostKey', 'cwd', 'agentId']),
      ...Object.fromEntries(['id', 'hostKey', 'folder'].filter(key => row.meta?.[key] !== undefined).map(key => [`meta:${key}`, row.meta[key]])) };
    const observedScopes = [...(previous?.observedScopes || [])];
    if (!observedScopes.some(value => canonicalJson(value) === canonicalJson(scope))) observedScopes.push(scope);
    const providerSessionIds = [...new Set([...(previous?.providerSessionIds || []), reference.agentSessionId].filter(value => typeof value === 'string' && value))];
    references.set(row.executionId, { ...previous, ...reference, evidence: 'nativeHeader', providerSessionIds, observedScopes,
      ...(providerSessionIds.length > 1 ? { requiresIdentityReview: true } : {}) });
  };
  for (const line of decoded.split('\n')) {
    if (!line) continue;
    records++;
    let value;
    try { value = JSON.parse(line); } catch { fail(`Invalid complete journal record ${records}; the original was kept.`); }
    if (value?.version !== 1 || !object(value.record)) fail(`Unsupported journal record ${records}; the original was kept.`);
    const record = value.record;
    if (record.op === 'create') {
      if (!object(record.row) || !Array.isArray(record.row.transcript)) fail('Invalid initial conversation record.');
      if (!row) {
        for (const event of record.row.transcript) referenceEvent(event);
        row = Object.assign(Object.create(null), record.row, { transcript: includeHistory ? [...record.row.transcript] : [] });
      }
    } else {
      if (!row) fail('The conversation is missing its initial record.');
      if (record.op === 'metadata') {
        if (!object(record.meta)) fail('Invalid conversation metadata record.');
        const activity = Math.max(...[row.meta?.activityAt, row.touchedAt, record.meta.activityAt].map(value => integer(value) ? value : 0));
        row.meta = { ...record.meta, activityAt: activity };
      } else if (record.op === 'update' || record.op === 'event') {
        if (!object(record.fields)) fail('Invalid execution fields.');
        const event = record.event;
        if (record.op === 'event') {
          if (!object(event) || !integer(event.sequence) || typeof event.type !== 'string') fail('Invalid saved history event.');
          if (record.fields.executionId === row.executionId && event.sequence <= (row.lastSequence || 0)) continue;
        }
        Object.assign(row, record.fields);
        if (record.op === 'event') {
          referenceEvent(event);
          if (integer(record.fields.touchedAt)) row.meta = { ...row.meta, activityAt: record.fields.touchedAt };
          if (event.type === 'userMessage' && !row.meta?.title) {
            if (event.text !== undefined && event.text !== null && typeof event.text !== 'string') fail('Invalid saved user message.');
            row.meta = { ...row.meta, title: [...(event.text || '').split('\n')[0]].slice(0, 160).join('') };
          }
          if (includeHistory) {
            if (event.type === 'historyReverted' && event.messageId) {
              const index = row.transcript.findIndex(item => item.type === 'userMessage' && item.messageId === event.messageId);
              if (index >= 0) row.transcript.length = index;
            }
            const last = row.transcript.at(-1);
            if (['assistantChunk', 'reasoningChunk'].includes(event.type) && last?.type === event.type
                && last.messageId === event.messageId && last.attemptId === event.attemptId) {
              row.transcript[row.transcript.length - 1] = { ...last, text: (last.text || '') + (event.text || ''), endSequence: event.sequence };
            } else row.transcript.push(event);
          }
        }
      } else fail('Unsupported conversation record; originals were kept.');
    }
    observe();
  }
  if (!row || !object(row.meta)) fail('The conversation is missing its initial record or metadata.');
  for (const event of row.transcript) referenceEvent(event);
  return { row, references: [...references.values()], records, completeBytes: end, interruptedTailBytes: bytes.length - end };
}

function safeRequest(value) {
  if (!object(value)) return undefined;
  const result = {};
  if (typeof value.requestId === 'string' || integer(value.requestId)) result.requestId = value.requestId;
  if (['permission', 'question'].includes(value.kind)) result.kind = value.kind;
  if (typeof value.title === 'string') result.title = value.title;
  if (['answered', 'dismissed', 'approved', 'rejected', 'cancelled', 'uncertain'].includes(value.outcome)) result.outcome = value.outcome;
  return result;
}
function historicalEvent(event) {
  if (!object(event) || !integer(event.sequence) || typeof event.type !== 'string') fail('Invalid history event; the original was kept.');
  const strings = ['attemptId', 'type', 'text', 'source', 'toolCallId', 'title', 'detail', 'status', 'messageId', 'toolKind', 'outputDelta', 'state'];
  for (const key of strings) if (event[key] !== undefined && event[key] !== null && typeof event[key] !== 'string') fail('Invalid historical text field; the original was kept.');
  if (event.endSequence !== undefined && (!integer(event.endSequence) || event.endSequence < event.sequence)) fail('Invalid historical event boundary.');
  const result = pick(event, ['sequence', 'endSequence', ...strings]);
  const origin = pick(event, ['sequence', 'endSequence', 'attemptId']);
  if (event.type === 'permission' || event.type === 'input') {
    const request = event.type === 'permission' ? event.permission : event.input;
    return { ...origin, type: 'agentRequest', request: safeRequest({ requestId: request?.requestId,
      kind: event.type === 'permission' ? 'permission' : 'question', title: typeof request?.title === 'string' ? request.title : 'Historical agent request' }) };
  } else if (event.type === 'agentRequest') {
    return { ...origin, type: 'agentRequest', request: safeRequest(event.request) };
  } else if (event.type === 'requestOutcome') {
    return { ...origin, type: 'requestOutcome', requestOutcome: safeRequest(event.requestOutcome) };
  } else if (event.type === 'subagentRequest') {
    return { ...origin, type: 'notice', text: 'Historical delegation request; its action payload was not exported.' };
  }
  if (object(event.request)) result.request = safeRequest(event.request);
  if (object(event.requestOutcome)) result.requestOutcome = safeRequest(event.requestOutcome);
  if (Array.isArray(event.content)) result.content = event.content.flatMap(part => {
    if (part?.type === 'content' && part.content?.type === 'text' && typeof part.content.text === 'string') return [{ type: 'content', content: { type: 'text', text: part.content.text } }];
    if (['diff', 'patch'].includes(part?.type) && text(part.path) && !/^(?:file:|[a-z]:[\\/])/i.test(part.path)
        && (part.type === 'patch' ? typeof part.patch === 'string' : typeof part.newText === 'string' && (part.oldText === undefined || part.oldText === null || typeof part.oldText === 'string'))) return [pick(part, ['type', 'path', 'oldText', 'newText', 'patch'])];
    return [];
  });
  if (Array.isArray(event.plan)) result.plan = event.plan.filter(item => object(item) && ['content', 'status', 'priority'].every(key => typeof item[key] === 'string')).map(item => pick(item, ['content', 'status', 'priority']));
  if (object(event.todos)) {
    if (!integer(event.todos.protocolVersion) || !integer(event.todos.revision)) fail('Invalid historical Todo version/revision.');
    result.todos = { protocolVersion: event.todos.protocolVersion, revision: event.todos.revision,
    items: Array.isArray(event.todos.items) ? event.todos.items.filter(item => object(item) && typeof item.id === 'string' && typeof item.title === 'string' && ['pending', 'completed'].includes(item.status))
      .map(item => Object.fromEntries(Object.entries(pick(item, ['id', 'title', 'status', 'createdBy', 'updatedBy', 'createdAt', 'startedAt', 'completedAt', 'durationMs', 'detail']))
        .filter(([_key, value]) => typeof value === 'string' || integer(value)))) : [], toolAvailable: false, available: false };
  }
  return result;
}

function project(snapshot, expectedId, source, includeHistory) {
  const { row, references } = snapshot;
  const identities = [row.meta.id, row.conversationId].filter(value => value !== undefined && value !== null && value !== '');
  if (!identities.length || identities.some(id => id !== expectedId)) fail('Conversation identity does not match its native filename.');
  const account = parseAccount(row.meta.hostKey || row.hostKey);
  if (row.hostKey && parseAccount(row.hostKey).hostKey !== account.hostKey) fail('Header and metadata belong to different SSH accounts.');
  if (!text(row.cwd) || !row.cwd.startsWith('/') || row.meta.folder && row.meta.folder !== row.cwd) fail('The original remote project folder is not confirmed.');
  if (!text(row.agentId, 160) || !row.agentId) fail('The provider identity is missing.');
  const labels = { opencode: 'OpenCode', pi: 'Pi', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI' };
  const agentName = text(row.agentName, 160) && row.agentName ? row.agentName : Object.hasOwn(labels, row.agentId) ? labels[row.agentId] : row.agentId;
  if (!text(row.executionId, 160) || !row.executionId) fail('The execution identity is missing.');
  if (row.agentSessionId !== null && row.agentSessionId !== undefined && !text(row.agentSessionId)) fail('The saved provider session identity is invalid.');
  for (const reference of references) {
    if (!text(reference.executionId, 160) || !reference.executionId) fail('An execution reference is invalid.');
    if (reference.agentSessionId !== undefined && reference.agentSessionId !== null && !text(reference.agentSessionId)) fail('A historical provider-session identity is invalid.');
    for (const scope of reference.observedScopes || []) {
      if ([scope.hostKey, scope['meta:hostKey']].some(key => key && parseAccount(key).hostKey !== account.hostKey)
          || [scope.cwd, scope['meta:folder']].some(folder => folder && folder !== row.cwd)
          || scope.agentId && scope.agentId !== row.agentId
          || [scope.conversationId, scope['meta:id']].some(id => id && id !== expectedId)) fail('Historical account/project/conversation scope changed; explicit reconciliation is required.');
    }
    if (reference.evidence === 'nativeHeader' && (reference.agentId && reference.agentId !== row.agentId || reference.cwd && reference.cwd !== row.cwd
        || reference.hostKey && parseAccount(reference.hostKey).hostKey !== account.hostKey)) fail('A historical execution changed account/project/provider scope; explicit reconciliation is required.');
  }
  const meta = {};
  if (row.meta.title !== undefined) {
    if (typeof row.meta.title !== 'string' || row.meta.title.length > 4096) fail('The saved title is invalid.');
    meta.title = row.meta.title;
  }
  if (['user', 'agent', 'prompt'].includes(row.meta.titleSource)) meta.titleSource = row.meta.titleSource;
  if (row.meta.pinned !== undefined) {
    if (typeof row.meta.pinned !== 'boolean') fail('The saved pin state is invalid.');
    meta.pinned = row.meta.pinned;
  }
  for (const key of ['archivedAt', 'createdAt', 'activityAt', 'order']) if (row.meta[key] !== undefined && row.meta[key] !== null) {
    if (!Number.isFinite(row.meta[key]) || row.meta[key] < 0 || row.meta[key] > Number.MAX_SAFE_INTEGER) fail('A saved organization timestamp/order is invalid.');
    meta[key] = Math.trunc(row.meta[key]);
  }
  const events = includeHistory ? row.transcript.map(historicalEvent) : [];
  return { conversationId: expectedId, account, agentId: row.agentId, agentName, cwd: row.cwd,
    ...(text(row.parentConversationId, 100) && row.parentConversationId ? { parentConversationId: row.parentConversationId } : {}),
    executionId: row.executionId, agentSessionId: row.agentSessionId || null, resumeReportedByDevice: row.resumable === true,
    executionReferences: references, organization: meta,
    sourceState: { state: text(row.state, 64) ? row.state : 'unknown', turnActive: row.turnActive === true,
      recoveryRequired: row.recoveryRequired === true || row.meta.submissionUnknown === true || references.some(reference => reference.requiresIdentityReview)
        || ['submissionUnknown', 'rewinding'].includes(row.state),
      deviceOnlyDraftOmitted: !!row.meta.draft || !!row.meta.draftAttachments?.length },
    history: { kind: 'device-cache', authority: 'historical-only', included: includeHistory,
      coverage: snapshot.interruptedTailBytes ? 'complete-records-only' : 'visible-native-snapshot',
      events, unscopedEventCount: events.filter(event => !event.attemptId).length },
    provenance: { ...source, records: snapshot.records, completeBytes: snapshot.completeBytes, interruptedTailBytes: snapshot.interruptedTailBytes } };
}

function sourceFiles(library) {
  ordinary(library, true);
  const names = readdirSync(library).filter(name => /^(?:[a-f0-9]{2})+\.(?:jsonl|deleted)$/.test(name)).sort();
  if (names.length > MAX_FILES) fail('The library exceeds the 4,096-file safety limit.');
  return names.map(name => { const info = ordinary(join(library, name)); return { name, path: join(library, name), stamp: stamp(info), size: String(info.size) }; });
}
export function assertLibraryUnchanged({ library, files }) {
  if (canonicalJson(sourceFiles(library).map(file => [file.name, file.stamp])) !== canonicalJson(files.map(file => [file.name, file.stamp]))) {
    fail('The Windows library changed. Quit Still normally and retry; originals were not changed.');
  }
}

export function inspectLibrary(library) {
  ordinary(resolve(library), true);
  library = realpathSync(resolve(library));
  const files = sourceFiles(library), deleted = new Set(files.filter(file => file.name.endsWith('.deleted')).map(file => file.name.slice(0, -8)));
  const entries = [], problems = [], accounts = new Map();
  const active = files.filter(file => file.name.endsWith('.jsonl') && !deleted.has(file.name.slice(0, -6)));
  if (active.reduce((sum, file) => sum + BigInt(file.size), 0n) > BigInt(MAX_LIBRARY)) fail('The library exceeds the 512 MiB safety limit; request a bounded/batched export.');
  for (const file of files) {
    if (!file.name.endsWith('.jsonl') || deleted.has(file.name.slice(0, -6))) continue;
    try {
      const source = readStable(file.path, file.stamp);
      const id = journalId(file.name), replayed = replayJournal(source.bytes), conversation = project(replayed, id, { file: file.name, sha256: source.sha256, bytes: source.bytes.length }, false);
      entries.push({ ...file, sha256: source.sha256, conversation });
      const account = accounts.get(conversation.account.hostKey) || { ...conversation.account, accountId: digest(conversation.account.hostKey).slice(0, 16), conversations: 0, executionReferences: 0 };
      account.conversations++; account.executionReferences += conversation.executionReferences.length;
      accounts.set(account.hostKey, account);
    } catch (error) { problems.push({ file: file.name, reason: error.code ? `Source file could not be read (${error.code}); the original was kept.` : error.message }); }
  }
  assertLibraryUnchanged({ library, files });
  return { library, files, entries, problems, deletedFiles: files.filter(file => file.name.endsWith('.deleted')).length,
    accounts: [...accounts.values()].sort((a, b) => a.hostKey < b.hostKey ? -1 : a.hostKey > b.hostKey ? 1 : 0) };
}

function secureOutput(directory) {
  if (process.platform !== 'win32') return;
  const system = process.env.SystemRoot || process.env.WINDIR;
  if (!system || !isAbsolute(system)) fail('The Windows system directory is not available for private export permissions.');
  const identity = spawnSync(join(system, 'System32/whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  const sid = identity.status === 0 ? identity.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0] : null;
  if (!sid) fail('Could not verify the current Windows account for private export permissions.');
  const acl = spawnSync(join(system, 'System32/icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (acl.status !== 0) fail('Could not make the export directory private. Choose a private NTFS profile folder.');
}
function writePrivate(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function missing(path) {
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail('The export destination already exists; choose a new folder. Nothing was overwritten.');
}

export function exportLibrary({ library, account, output, includeHistory = false }) {
  const inventory = inspectLibrary(library);
  const matches = inventory.accounts.filter(value => value.accountId === account);
  if (matches.length !== 1) fail('Copy the exact account ID shown by --list; no account was guessed.');
  const selected = matches[0];
  if (typeof output !== 'string' || !output) fail('Provide a new export folder.');
  const parent = realpathSync(dirname(resolve(output))), destination = join(parent, basename(resolve(output)));
  const inside = relative(inventory.library, destination);
  if (!inside || !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)) fail('The export must be outside Still\'s library.');
  missing(destination);
  const staging = mkdtempSync(join(parent, '.still-library-export-'));
  let committed = false;
  try {
    secureOutput(staging);
    mkdirSync(join(staging, 'originals'), { mode: 0o700 });
    const conversations = [], sources = [];
    for (const entry of inventory.entries.filter(entry => entry.conversation.account.hostKey === selected.hostKey)) {
      const source = readStable(entry.path, entry.stamp);
      if (source.sha256 !== entry.sha256) fail('A source journal changed; export was not committed.');
      const replayed = replayJournal(source.bytes, includeHistory);
      const conversation = project(replayed, entry.conversation.conversationId, { file: entry.name, sha256: source.sha256, bytes: source.bytes.length }, includeHistory);
      conversations.push(conversation);
      writePrivate(join(staging, 'originals', entry.name), source.bytes);
      sources.push({ file: entry.name, bytes: source.bytes.length, sha256: source.sha256 });
    }
    const payload = { schemaVersion: 1, kind: 'still-desktop-library-export', account: pick(selected, ['hostKey', 'host', 'port', 'username']), conversations,
      omissions: ['saved credentials', 'unsent drafts', 'attachment files and local attachment references', 'raw tool inputs/outputs', 'request schemas and answer values', 'current capabilities and actionable checkpoints'],
      reviewRequired: conversations.filter(row => row.sourceState.recoveryRequired || row.provenance.interruptedTailBytes > 0)
        .map(row => ({ conversationId: row.conversationId, reason: row.provenance.interruptedTailBytes ? 'Interrupted native journal tail' : 'Unconfirmed operation or provider identity conflict' })),
      unscopedSourcesNotExported: inventory.problems.length > 0 };
    const exportId = digest(canonicalJson(payload));
    const document = Buffer.from(JSON.stringify({ ...payload, exportId, createdAt: new Date().toISOString() }, null, 2) + '\n');
    if (document.length > MAX_EXPORT) fail('The portable export exceeds 128 MiB; request a bounded/batched export.');
    writePrivate(join(staging, 'library-export.json'), document);
    writePrivate(join(staging, 'manifest.json'), JSON.stringify({ schemaVersion: 1, exportId, portableSha256: digest(document), originalsLocalOnly: true, sources,
      sourceProblemsLocalOnly: inventory.problems, deviceTombstonesRetained: inventory.deletedFiles }, null, 2) + '\n');
    assertLibraryUnchanged(inventory);
    missing(destination); renameSync(staging, destination); committed = true;
    return { directory: destination, exportFile: join(destination, 'library-export.json'), exportId, conversations: conversations.length,
      events: conversations.reduce((sum, row) => sum + row.history.events.length, 0), reviewRequired: inventory.problems.length };
  } finally { if (!committed) rmSync(staging, { recursive: true, force: true }); }
}

function locateLibrary(explicit) {
  if (explicit) { ordinary(resolve(explicit), true); return resolve(explicit); }
  if (process.platform !== 'win32') fail('Run this script on Windows, or explicitly provide --library for an offline copy.');
  const candidates = [...new Set([process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map(root => join(root, 'dev.still.app', 'agents')))].filter(existsSync);
  if (candidates.length !== 1) fail(candidates.length ? `More than one native library exists. Use --library with one of: ${candidates.join(', ')}`
    : 'No native Still library was found. Do not reinstall or clear data: the older chats may still be in WebView storage. Report this result before proceeding.');
  ordinary(candidates[0], true); return candidates[0];
}

export function runCli(args) {
  if (Number(process.versions.node.split('.')[0]) < 18) fail('Use Node.js 18 or newer; no npm installation is needed.');
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (Object.hasOwn(options, key)) fail('Duplicate option; no account or output was guessed.');
    if (['--list', '--with-history', '--help'].includes(key)) options[key] = true;
    else if (['--library', '--account', '--output'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) options[key] = args[++index];
    else fail('Unknown or incomplete option. Run with --help.');
  }
  if (options['--help']) {
    console.log('Read-only Still desktop export (Node.js 18+, no npm dependencies).\n' +
      '  node export-windows-library.mjs --list [--library PATH]\n' +
      '  node export-windows-library.mjs --account ACCOUNT_ID --output NEW_FOLDER [--with-history] [--library PATH]\n' +
      'Quit Still normally before creating an export. Inventory is read-only. No network requests or agent commands run.\n' +
      'The originals/ backup stays on Windows; transfer only library-export.json after reviewing its private contents.');
    return;
  }
  const library = locateLibrary(options['--library']);
  if (options['--list'] || !options['--account']) {
    const inventory = inspectLibrary(library);
    console.log('Read-only inventory; no source files were changed.');
    inventory.accounts.forEach(account => console.log(`${account.accountId}  ${account.username}@${account.host}:${account.port} — ${account.conversations} conversations, ${account.executionReferences} known execution references`));
    if (!inventory.accounts.length) console.log('No exportable native conversations found. Keep the Windows data intact; the visible chats may still be in older WebView storage.');
    for (const problem of inventory.problems) console.log(`Needs review: ${problem.file}: ${problem.reason}`);
    return;
  }
  if (!options['--output']) fail('Provide --output with a new private folder outside Still\'s library.');
  const result = exportLibrary({ library, account: options['--account'], output: options['--output'], includeHistory: options['--with-history'] === true });
  console.log(`Exported ${result.conversations} conversations and ${result.events} historical events. Originals were not changed.`);
  console.log(`Portable file: ${result.exportFile}\nLocal-only backup: ${join(result.directory, 'originals')}\nExport ID: ${result.exportId}`);
  if (result.reviewRequired) console.log(`${result.reviewRequired} source files need review; no identities were guessed.`);
  console.log('This is an export, not a completed server import. Keep originals/ on Windows. Historical text can contain private information.');
}

let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* Imported or evaluated as a module, not a CLI invocation. */ }
if (invokedDirectly) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { console.error(`Export stopped: ${error.message}`); process.exitCode = 1; }
}

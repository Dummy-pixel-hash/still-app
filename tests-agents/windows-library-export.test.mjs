import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertLibraryUnchanged, canonicalJson, exportLibrary, inspectLibrary, replayJournal } from '../scripts/migration/export-windows-library.mjs';

const script = fileURLToPath(new URL('../scripts/migration/export-windows-library.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const host = JSON.stringify(['home-work.example.test', 22, 'Darsh']);
const otherHost = JSON.stringify(['another-account.example.test', 2222, 'other']);
const nameOf = id => Buffer.from(id).toString('hex') + '.jsonl';
const record = value => JSON.stringify({ version: 1, record: value }) + '\n';
function row(id, overrides = {}) {
  return { conversationId: id, executionId: `execution-${id}`, localSessionId: 'device-only-connection-id', hostKey: host,
    agentId: 'opencode', agentName: 'OpenCode', agentSessionId: `provider-${id}`, cwd: '/srv/project', state: 'complete',
    lastSequence: 0, turnActive: false, resumable: true, transcript: [],
    meta: { id, hostKey: host, folder: '/srv/project', title: 'Original Windows title', titleSource: 'user', pinned: true,
      createdAt: 1, activityAt: 2, order: 2, draft: 'DRAFT_DO_NOT_EXPORT', draftAttachments: [{ localPath: 'LOCAL_ATTACHMENT_DO_NOT_EXPORT' }] }, ...overrides };
}
function fixture(t) {
  const base = process.platform !== 'win32' && existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
  const root = mkdtempSync(join(base, 'still-windows-export-')), library = join(root, 'agents');
  mkdirSync(library, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (id, records, tail = '') => {
    const path = join(library, nameOf(id));
    writeFileSync(path, records.map(record).join('') + tail, { mode: 0o600 });
    return path;
  };
  return { root, library, write, account: () => inspectLibrary(library).accounts.find(account => account.hostKey === host).accountId };
}
function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory).map(name => {
    const file = join(directory, name), info = statSync(file, { bigint: true });
    return [name, { sha256: hash(readFileSync(file)), size: String(info.size), modified: String(info.mtimeNs), mode: String(info.mode) }];
  }));
}

test('the standalone inventory is read-only and lists account IDs without credentials or draft text', t => {
  const f = fixture(t);
  f.write('one', [{ op: 'create', row: row('one') }]);
  writeFileSync(join(f.library, 'workspace.jsonl'), 'CREDENTIAL_STORE_MARKER');
  writeFileSync(join(f.library, 'private-key.pem'), 'CREDENTIAL_STORE_MARKER');
  const before = snapshot(f.library);
  const result = spawnSync(process.execPath, [script, '--list', '--library', f.library], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Darsh@home-work\.example\.test:22.*1 conversations/);
  assert.match(result.stdout, new RegExp(f.account()));
  for (const secret of ['DRAFT_DO_NOT_EXPORT', 'CREDENTIAL_STORE_MARKER', 'LOCAL_ATTACHMENT_DO_NOT_EXPORT']) assert.equal(result.stdout.includes(secret), false);
  assert.deepEqual(snapshot(f.library), before);
  assert.deepEqual(readdirSync(f.root), ['agents']);
});

test('stable account IDs select the same account even if another account changes list order', t => {
  const f = fixture(t);
  f.write('wanted', [{ op: 'create', row: row('wanted') }]);
  const selected = f.account();
  const foreign = row('foreign', { hostKey: otherHost }); foreign.meta.hostKey = otherHost;
  f.write('foreign', [{ op: 'create', row: foreign }]);
  const result = exportLibrary({ library: f.library, account: selected, output: join(f.root, 'export') });
  const document = JSON.parse(readFileSync(result.exportFile));
  assert.equal(document.conversations.length, 1);
  assert.equal(document.conversations[0].conversationId, 'wanted');
  assert.equal(document.account.hostKey, host);
  assert.equal(document.conversations[0].history.included, false);
  assert.deepEqual(document.conversations[0].history.events, []);
  assert.throws(() => exportLibrary({ library: f.library, account: 1, output: join(f.root, 'wrong') }), /exact account ID/);
});

test('export creates verified local-only original backups and does not change source journals', t => {
  const f = fixture(t), file = f.write('one', [{ op: 'create', row: row('one') }]);
  const before = snapshot(f.library), output = join(f.root, 'export');
  const result = exportLibrary({ library: f.library, account: f.account(), output });
  const document = JSON.parse(readFileSync(result.exportFile)), manifest = JSON.parse(readFileSync(join(output, 'manifest.json')));
  assert.deepEqual(readFileSync(join(output, 'originals', nameOf('one'))), readFileSync(file));
  assert.equal(manifest.sources[0].sha256, hash(readFileSync(file)));
  assert.equal(manifest.portableSha256, hash(readFileSync(result.exportFile)));
  const { exportId, createdAt, ...payload } = document;
  assert.equal(exportId, hash(canonicalJson(payload)));
  assert.equal(typeof createdAt, 'string');
  assert.equal(manifest.originalsLocalOnly, true);
  assert.deepEqual(snapshot(f.library), before);
  assert.equal(JSON.stringify(document).includes('DRAFT_DO_NOT_EXPORT'), false);
  assert.equal(readFileSync(join(output, 'originals', nameOf('one')), 'utf8').includes('DRAFT_DO_NOT_EXPORT'), true);
  if (process.platform !== 'win32') {
    assert.equal(lstatSync(output).mode & 0o777, 0o700);
    assert.equal(lstatSync(result.exportFile).mode & 0o777, 0o600);
  } else {
    const acl = spawnSync(join(process.env.SystemRoot || process.env.WINDIR, 'System32/icacls.exe'), [output], { encoding: 'utf8' });
    assert.equal(acl.status, 0, acl.stderr);
    assert.doesNotMatch(acl.stdout, /(?:Everyone|BUILTIN\\Users):/i);
  }
});

test('metadata-only export retains old checkpoint execution references without inventing their provider IDs', t => {
  const f = fixture(t);
  const initial = row('one', { executionId: 'current-execution', lastSequence: 7,
    transcript: [{ sequence: 1, type: 'userMessage', attemptId: 'old-execution', text: 'PRIVATE_HISTORICAL_MESSAGE' }] });
  f.write('one', [{ op: 'create', row: initial }]);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export') });
  const document = JSON.parse(readFileSync(result.exportFile)), conversation = document.conversations[0];
  const old = conversation.executionReferences.find(reference => reference.executionId === 'old-execution');
  assert.equal(old.evidence, 'transcriptReference');
  assert.equal(old.agentSessionId, undefined);
  assert.equal(conversation.executionReferences.find(reference => reference.executionId === 'current-execution').evidence, 'nativeHeader');
  assert.equal(JSON.stringify(document).includes('PRIVATE_HISTORICAL_MESSAGE'), false);
});

test('native replay coalesces chunks, ignores duplicate sequences and retains visible rewind history', t => {
  const f = fixture(t), initial = row('one');
  const event = (sequence, value) => ({ op: 'event', fields: { executionId: initial.executionId, lastSequence: sequence }, event: { sequence, attemptId: initial.executionId, ...value } });
  const file = f.write('one', [{ op: 'create', row: initial },
    event(1, { type: 'userMessage', messageId: 'first', text: 'Keep this message' }),
    event(2, { type: 'assistantChunk', messageId: 'answer', text: 'First ' }),
    event(3, { type: 'assistantChunk', messageId: 'answer', text: 'second' }),
    event(3, { type: 'assistantChunk', messageId: 'answer', text: 'DUPLICATE_DO_NOT_KEEP' }),
    event(4, { type: 'userMessage', messageId: 'second', text: 'REVERTED_DO_NOT_KEEP' }),
    event(5, { type: 'assistantChunk', text: 'REVERTED_ANSWER_DO_NOT_KEEP' }),
    event(6, { type: 'historyReverted', messageId: 'second' }),
    { op: 'metadata', meta: { ...initial.meta, title: 'Renamed on Windows', activityAt: 0 } }]);
  const replayed = replayJournal(readFileSync(file), true);
  assert.equal(replayed.row.transcript[1].text, 'First second');
  assert.equal(replayed.row.transcript[1].endSequence, 3);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export'), includeHistory: true });
  const document = JSON.parse(readFileSync(result.exportFile)), value = document.conversations[0];
  assert.equal(value.organization.title, 'Renamed on Windows');
  assert.equal(value.history.authority, 'historical-only');
  assert.equal(value.history.events[1].text, 'First second');
  assert.doesNotMatch(JSON.stringify(document), /DUPLICATE_DO_NOT_KEEP|REVERTED_DO_NOT_KEEP|REVERTED_ANSWER_DO_NOT_KEEP/);
});

test('history opt-in excludes structured credentials, request values, local attachments and actionable commands', t => {
  const f = fixture(t);
  const initial = row('one', { lastSequence: 7, pendingInput: { answers: 'ANSWER_SECRET' }, customAgent: { args: ['API_KEY_SECRET'] },
    transcript: [
      { sequence: 1, type: 'userMessage', text: 'Visible old user message' },
      { sequence: 2, type: 'assistantMessage', text: 'Visible old assistant answer' },
      { sequence: 3, type: 'permission', text: 'RAW_REQUEST_TEXT_SECRET', detail: 'RAW_REQUEST_DETAIL_SECRET', permission: { requestId: 'p', title: 'Historical approval', rawInput: { password: 'PERMISSION_SECRET' } }, content: [{ type: 'content', content: { type: 'text', text: 'RAW_REQUEST_CONTENT_SECRET' } }] },
      { sequence: 4, type: 'input', input: { requestId: 'q', title: 'Historical question', schema: { password: 'FORM_SCHEMA_SECRET' }, answers: 'ANSWER_SECRET' } },
      { sequence: 5, type: 'requestOutcome', text: 'RAW_OUTCOME_SECRET', requestOutcome: { requestId: 'q', kind: 'question', title: 'Historical question', outcome: 'answered', responseLabel: 'ANSWER_SECRET' } },
      { sequence: 6, type: 'toolUpdate', title: 'Edit a file', rawInput: { key: 'RAW_TOOL_SECRET' }, rawOutput: { password: 'RAW_OUTPUT_SECRET' }, checkpoint: { key: 'CHECKPOINT_SECRET' },
        content: [{ type: 'diff', path: 'src/main.ts', oldText: 'old', newText: 'new' }, { type: 'patch', path: 'C:\\Users\\private', patch: 'LOCAL_PATCH_SECRET' }, { type: 'content', content: { type: 'image', data: 'IMAGE_SECRET' } }] },
      { sequence: 7, type: 'subagentRequest', text: 'UNSENT_GUIDANCE_SECRET', subagentRequest: { input: { task: 'QUEUED_TASK_SECRET' } } },
    ] });
  f.write('one', [{ op: 'create', row: initial }]);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export'), includeHistory: true });
  const encoded = readFileSync(result.exportFile, 'utf8'), document = JSON.parse(encoded), events = document.conversations[0].history.events;
  assert.match(encoded, /Visible old user message/);
  assert.match(encoded, /Visible old assistant answer/);
  for (const secret of ['DRAFT_DO_NOT_EXPORT', 'LOCAL_ATTACHMENT_DO_NOT_EXPORT', 'API_KEY_SECRET', 'PERMISSION_SECRET', 'FORM_SCHEMA_SECRET', 'ANSWER_SECRET',
    'RAW_REQUEST_TEXT_SECRET', 'RAW_REQUEST_DETAIL_SECRET', 'RAW_REQUEST_CONTENT_SECRET', 'RAW_OUTCOME_SECRET', 'RAW_TOOL_SECRET', 'RAW_OUTPUT_SECRET', 'CHECKPOINT_SECRET', 'LOCAL_PATCH_SECRET', 'IMAGE_SECRET', 'UNSENT_GUIDANCE_SECRET', 'QUEUED_TASK_SECRET']) assert.equal(encoded.includes(secret), false, secret);
  assert.equal(events[2].type, 'agentRequest');
  assert.equal(events[4].requestOutcome.outcome, 'answered');
  assert.deepEqual(events[5].content, [{ type: 'diff', path: 'src/main.ts', oldText: 'old', newText: 'new' }]);
});

test('tombstones prevent old device conversations from being exported or resurrected', t => {
  const f = fixture(t);
  f.write('kept', [{ op: 'create', row: row('kept') }]);
  f.write('deleted', [{ op: 'create', row: row('deleted') }]);
  writeFileSync(join(f.library, nameOf('deleted').replace('.jsonl', '.deleted')), '');
  const inventory = inspectLibrary(f.library);
  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.deletedFiles, 1);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export') });
  const document = JSON.parse(readFileSync(result.exportFile));
  assert.deepEqual(document.conversations.map(value => value.conversationId), ['kept']);
  assert.equal(document.deviceTombstonesNotShared, undefined);
  assert.equal(JSON.parse(readFileSync(join(result.directory, 'manifest.json'))).deviceTombstonesRetained, 1);
});

test('interrupted suffixes are preserved locally and explicitly marked partial rather than repaired in place', t => {
  const f = fixture(t), tail = '{"version":1,"record":';
  const file = f.write('one', [{ op: 'create', row: row('one') }], tail), before = readFileSync(file);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export'), includeHistory: true });
  const conversation = JSON.parse(readFileSync(result.exportFile)).conversations[0];
  assert.equal(conversation.provenance.interruptedTailBytes, Buffer.byteLength(tail));
  assert.equal(conversation.history.coverage, 'complete-records-only');
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readFileSync(join(result.directory, 'originals', nameOf('one'))), before);
  assert.equal(readdirSync(f.library).some(name => name.includes('interrupted-')), false);
});

test('corrupt complete records are reported without copying content into diagnostics or hiding healthy accounts', t => {
  const f = fixture(t);
  f.write('healthy', [{ op: 'create', row: row('healthy') }]);
  const broken = f.write('broken', [{ op: 'create', row: row('broken') }], '{CORRUPT_PRIVATE_CONTENT}\n'), original = readFileSync(broken);
  const inventory = inspectLibrary(f.library);
  assert.equal(inventory.entries.length, 1);
  assert.equal(inventory.problems.length, 1);
  assert.equal(JSON.stringify(inventory.problems).includes('CORRUPT_PRIVATE_CONTENT'), false);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export') });
  assert.equal(result.reviewRequired, 1);
  const portable = readFileSync(result.exportFile, 'utf8');
  assert.equal(portable.includes(nameOf('broken')), false, 'unscoped source filenames stay in local-only diagnostics');
  assert.equal(JSON.parse(portable).unscopedSourcesNotExported, true);
  assert.deepEqual(readFileSync(broken), original);
});

test('historical account/project changes cannot be smuggled into one selected account', t => {
  const f = fixture(t), initial = row('changed');
  f.write('changed', [{ op: 'create', row: initial },
    { op: 'update', fields: { hostKey: otherHost, cwd: '/srv/other' } },
    { op: 'metadata', meta: { ...initial.meta, hostKey: otherHost, folder: '/srv/other' } }]);
  const inventory = inspectLibrary(f.library);
  assert.equal(inventory.accounts.length, 0);
  assert.match(inventory.problems[0].reason, /scope changed/);
});

test('different provider sessions observed under one execution are retained as evidence requiring review', t => {
  const f = fixture(t), initial = row('one');
  f.write('one', [{ op: 'create', row: initial }, { op: 'update', fields: { agentSessionId: 'different-provider-session' } }]);
  const result = exportLibrary({ library: f.library, account: f.account(), output: join(f.root, 'export') });
  const conversation = JSON.parse(readFileSync(result.exportFile)).conversations[0];
  assert.equal(conversation.sourceState.recoveryRequired, true);
  assert.deepEqual(conversation.executionReferences[0].providerSessionIds, ['provider-one', 'different-provider-session']);
  assert.equal(conversation.executionReferences[0].requiresIdentityReview, true);
});

test('source changes and new deletion markers invalidate the preview snapshot', t => {
  const f = fixture(t), file = f.write('one', [{ op: 'create', row: row('one') }]);
  const inventory = inspectLibrary(f.library);
  writeFileSync(file, readFileSync(file) + record({ op: 'update', fields: { lastSequence: 10 } }));
  assert.throws(() => assertLibraryUnchanged(inventory), /library changed/);
  const next = inspectLibrary(f.library);
  writeFileSync(join(f.library, nameOf('one').replace('.jsonl', '.deleted')), '');
  assert.throws(() => assertLibraryUnchanged(next), /library changed/);
});

test('existing output and misleading dot-prefixed paths inside the native library are refused', t => {
  const f = fixture(t);
  f.write('one', [{ op: 'create', row: row('one') }]);
  const output = join(f.root, 'existing'); mkdirSync(output); writeFileSync(join(output, 'keep.txt'), 'keep');
  assert.throws(() => exportLibrary({ library: f.library, account: f.account(), output }), /already exists/);
  assert.equal(readFileSync(join(output, 'keep.txt'), 'utf8'), 'keep');
  for (const name of ['new-export', '..still-export']) assert.throws(() => exportLibrary({ library: f.library, account: f.account(), output: join(f.library, name) }), /outside Still/);
  assert.deepEqual(readdirSync(f.library), [nameOf('one')]);
});

test('symbolic source journals are never followed', t => {
  const f = fixture(t), target = join(f.root, 'private.json');
  writeFileSync(target, 'PRIVATE_FILE_DO_NOT_READ');
  try { symlinkSync(target, join(f.library, nameOf('one')), 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows symlink privilege is not available'); return; } throw error; }
  assert.throws(() => inspectLibrary(f.library), /symbolic links/);
  assert.equal(readFileSync(target, 'utf8'), 'PRIVATE_FILE_DO_NOT_READ');
});

test('quota checks reject a sparse oversized source before allocating or exporting it', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), path = join(f.library, nameOf('huge'));
  writeFileSync(path, ''); truncateSync(path, 513 * 1024 * 1024);
  assert.throws(() => inspectLibrary(f.library), /512 MiB safety limit/);
  assert.equal(readdirSync(f.root).length, 1);
});

test('same quiescent source produces the same content-based export identity', t => {
  const f = fixture(t);
  f.write('one', [{ op: 'create', row: row('one') }]);
  const options = { library: f.library, account: f.account(), includeHistory: true };
  const a = exportLibrary({ ...options, output: join(f.root, 'first') });
  const b = exportLibrary({ ...options, output: join(f.root, 'second') });
  assert.equal(a.exportId, b.exportId);
});

test('a native filename mismatch is not repaired by guessing an identity', t => {
  const f = fixture(t);
  f.write('one', [{ op: 'create', row: row('different-identity') }]);
  const inventory = inspectLibrary(f.library);
  assert.equal(inventory.entries.length, 0);
  assert.match(inventory.problems[0].reason, /identity does not match/);
});

test('older optional display fields do not hide an explicit native conversation/provider identity', t => {
  const f = fixture(t), original = row('one');
  delete original.agentName; delete original.meta.id;
  f.write('one', [{ op: 'create', row: original }]);
  const inventory = inspectLibrary(f.library);
  assert.equal(inventory.problems.length, 0);
  assert.equal(inventory.entries[0].conversation.conversationId, 'one');
  assert.equal(inventory.entries[0].conversation.agentId, 'opencode');
  assert.equal(inventory.entries[0].conversation.agentName, 'OpenCode');
  delete original.conversationId;
  f.write('one', [{ op: 'create', row: original }]);
  assert.equal(inspectLibrary(f.library).entries.length, 0, 'a filename alone is not treated as a guessed logical identity');
});

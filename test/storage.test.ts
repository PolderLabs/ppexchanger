import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadMessagePage, loadState, MESSAGE_PAGE_SIZE, saveState, sanitizeFileName} from '../src/storage.js';

test('state storage creates a durable identity and preserves messages', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ppx-state-'));
	try {
		const first = await loadState(directory, 'alice');
		await saveState(directory, first.identity, first.peers, [{id: 'm1', peerId: 'peer', direction: 'outgoing', body: 'hello', createdAt: 1}]);
		const second = await loadState(directory);
		assert.equal(second.identity.peerId, first.identity.peerId);
		assert.equal(second.messages[0]?.body, 'hello');
		assert.match(await readFile(join(directory, 'state.json'), 'utf8'), /"version": 1/);
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
});

test('file names are confined to safe path components', () => {
	assert.equal(sanitizeFileName('../../secret.txt'), '____secret.txt');
	assert.equal(sanitizeFileName(''), 'attachment');
});

test('message history loads recent records first and pages older records from disk', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ppx-history-'));
	try {
		const state = await loadState(directory, 'alice');
		const history = Array.from({length: MESSAGE_PAGE_SIZE + 15}, (_, index) => ({
			id: `m${index}`,
			peerId: 'peer',
			direction: 'outgoing' as const,
			body: `message ${index}`,
			createdAt: index
		}));
		await saveState(directory, state.identity, state.peers, history, {...state.settings, maxMessages: 100});
		const loaded = await loadState(directory);
		assert.equal(loaded.messages.length, MESSAGE_PAGE_SIZE);
		assert.equal(loaded.messages[0]?.id, 'm15');
		assert.equal(loaded.messageCounts.peer, 55);
		const older = await loadMessagePage(directory, 'peer', loaded.messages[0]?.id);
		assert.equal(older.messages.length, 15);
		assert.equal(older.messages[0]?.id, 'm0');
		assert.equal(older.remaining, 0);
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
});

import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {NetworkService} from '../src/network.js';
import {loadState} from '../src/storage.js';
import type {NetworkEvent, Peer} from '../src/types.js';

test('two services establish an encrypted session and deliver text', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ppx-network-'));
	const aDirectory = join(root, 'a');
	const bDirectory = join(root, 'b');
	const aState = await loadState(aDirectory, 'alice');
	const bState = await loadState(bDirectory, 'bob');
	const alice = new NetworkService(aState.identity, 0, aDirectory);
	const bob = new NetworkService(bState.identity, 0, bDirectory);
	const received: NetworkEvent[] = [];
	bob.on('event', event => {
		const typed = event as NetworkEvent;
		received.push(typed);
		if (typed.type === 'file-offer') void bob.acceptFile(typed.peerId, typed.offer);
	});
	try {
		await alice.start();
		await bob.start();
		const bobPeer: Peer = {peerId: bState.identity.peerId, name: 'bob', hostname: 'localhost', address: '127.0.0.1', port: bob.localPort, publicKey: bState.identity.publicKey, fingerprint: bState.identity.fingerprint, status: 'discovered', trusted: false, lastSeen: Date.now()};
		alice.rememberPeer(bobPeer);
		await alice.connect(bobPeer.peerId);
		await alice.sendText(bobPeer.peerId, 'hello over the encrypted session');
		await waitFor(() => received.some(event => event.type === 'message'));
		const message = received.find(event => event.type === 'message');
		assert.equal(message?.type, 'message');
		if (message?.type === 'message') assert.equal(message.body, 'hello over the encrypted session');
		const source = join(root, 'note.txt');
		await writeFile(source, 'a small encrypted attachment\n');
		await alice.sendFile(bobPeer.peerId, source);
		await waitFor(() => received.some(event => event.type === 'file-received'));
		const file = received.find(event => event.type === 'file-received');
		assert.equal(file?.type, 'file-received');
		if (file?.type === 'file-received') assert.equal(await readFile(file.path, 'utf8'), 'a small encrypted attachment\n');
	} finally {
		await alice.stop();
		await bob.stop();
		await rm(root, {recursive: true, force: true});
	}
});

test('same-machine services discover each other through the local registry', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ppx-discovery-'));
	const aState = await loadState(join(root, 'a'), `discovery-alice-${process.pid}`);
	const bState = await loadState(join(root, 'b'), `discovery-bob-${process.pid}`);
	const alice = new NetworkService(aState.identity, 0, join(root, 'a'));
	const bob = new NetworkService(bState.identity, 0, join(root, 'b'));
	const alicePeers: NetworkEvent[] = [];
	const bobPeers: NetworkEvent[] = [];
	alice.on('event', event => alicePeers.push(event as NetworkEvent));
	bob.on('event', event => bobPeers.push(event as NetworkEvent));
	try {
		await alice.start();
		await bob.start();
		await waitFor(() => alicePeers.some(event => event.type === 'peer' && event.peer.name === bState.identity.name) && bobPeers.some(event => event.type === 'peer' && event.peer.name === aState.identity.name));
		assert.ok(alice.currentPeers.some(peer => peer.peerId === bState.identity.peerId));
		assert.ok(bob.currentPeers.some(peer => peer.peerId === aState.identity.peerId));
	} finally {
		await alice.stop();
		await bob.stop();
		await rm(root, {recursive: true, force: true});
	}
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
	assert.ok(predicate(), 'timed out waiting for network event');
}

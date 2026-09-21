import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {NetworkService} from '../src/network.js';
import {loadState} from '../src/storage.js';
import type {NetworkEvent} from '../src/types.js';

function peerStatus(events: NetworkEvent[], status: 'connected' | 'offline'): boolean {
	return events.some(event => event.type === 'peer-status' && event.status === status);
}

// Integration test against real sockets; cannot fake platform I/O clocks.
async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	if (!condition()) throw new Error('timed out waiting for condition');
}

test('network operations reject once the service has stopped', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ppx-harden-'));
	const aState = await loadState(join(dir, 'a'), `alice-${process.pid}-a`);
	const a = new NetworkService(aState.identity, 0, join(dir, 'a'));
	await a.start();
	await a.stop();
	const offer = {id: 'a'.repeat(32), name: 'x.bin', size: 1};
	await assert.rejects(() => a.connect('ghost'), /not running/);
	await assert.rejects(() => a.sendFile('ghost', '/nonexistent'), /not running/);
	await assert.rejects(() => a.acceptFile('ghost', offer), /not running/);
	// Rejecting an offer with no connection is a deliberate best-effort no-op.
	await a.rejectFile('ghost', offer);
});

test('disconnect marks the peer offline and stops further sends', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ppx-disconn-'));
	const aState = await loadState(join(dir, 'a'), `alice-${process.pid}-b`);
	const bState = await loadState(join(dir, 'b'), `bob-${process.pid}-b`);
	const a = new NetworkService(aState.identity, 0, join(dir, 'a'));
	const b = new NetworkService(bState.identity, 0, join(dir, 'b'));
	const events: NetworkEvent[] = [];
	b.on('event', event => events.push(event as NetworkEvent));
	try {
		await a.start();
		await b.start();
		a.rememberPeer({peerId: bState.identity.peerId, name: 'b', hostname: 'host-b', address: '127.0.0.1', port: b.localPort, publicKey: bState.identity.publicKey, fingerprint: bState.identity.fingerprint, status: 'discovered', trusted: false, lastSeen: Date.now()});
		await a.connect(bState.identity.peerId);
		await until(() => peerStatus(events, 'connected'));
		await a.disconnect(bState.identity.peerId);
		await until(() => peerStatus(events, 'offline'));
		await assert.rejects(() => a.sendText(bState.identity.peerId, 'after-disconnect'), /not connected/);
	} finally {
		await a.stop();
		await b.stop();
	}
});

test('accepting a second offer with the same id is refused', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ppx-collide-'));
	const aState = await loadState(join(dir, 'a'), `alice-${process.pid}-c`);
	const bState = await loadState(join(dir, 'b'), `bob-${process.pid}-c`);
	const a = new NetworkService(aState.identity, 0, join(dir, 'a'));
	const b = new NetworkService(bState.identity, 0, join(dir, 'b'));
	const events: NetworkEvent[] = [];
	a.on('event', event => events.push(event as NetworkEvent));
	try {
		await a.start();
		await b.start();
		const source = join(dir, 'collision-source.txt');
		await writeFile(source, 'payload');
		b.rememberPeer({peerId: aState.identity.peerId, name: 'alice', hostname: 'host-a', address: '127.0.0.1', port: a.localPort, publicKey: aState.identity.publicKey, fingerprint: aState.identity.fingerprint, status: 'discovered', trusted: false, lastSeen: Date.now()});
		await b.connect(aState.identity.peerId);
		await until(() => events.some(event => event.type === 'peer-status' && event.status === 'connected'));
		// Fire-and-forget: sendFile blocks on file-accept, so we don't await it.
		void b.sendFile(aState.identity.peerId, source).catch(() => undefined);
		await until(() => events.some(event => event.type === 'file-offer'));
		const offerEvent = events.find(event => event.type === 'file-offer');
		if (offerEvent?.type !== 'file-offer') throw new Error('expected a file-offer event');
		await a.acceptFile(bState.identity.peerId, offerEvent.offer);
		// Second accept with the same id must be refused.
		await assert.rejects(() => a.acceptFile(bState.identity.peerId, offerEvent.offer), /already accepted/);
	} finally {
		await a.stop();
		await b.stop();
	}
});

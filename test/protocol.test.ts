import assert from 'node:assert/strict';
import test from 'node:test';
import {generateX25519KeyPair} from '../src/crypto.js';
import {decodeBeacon, decodeEncryptedFrame, encodeBeacon, encodeEncryptedFrame} from '../src/protocol.js';

test('beacons round-trip with hostname and control port', () => {
	const identity = generateX25519KeyPair();
	const encoded = encodeBeacon({peerId: '0123456789abcdef0123456789abcdef', publicKey: identity.publicKey, tcpPort: 47391, name: 'alice', hostname: 'workstation', controlPort: 47392});
	const decoded = decodeBeacon(encoded);
	assert.ok(decoded);
	assert.equal(decoded.name, 'alice');
	assert.equal(decoded.hostname, 'workstation');
	assert.equal(decoded.controlPort, 47392);
	assert.deepEqual(decoded.publicKey, identity.publicKey);
});

test('encrypted frames reject a wrong key and preserve sequence ordering', () => {
	const key = Buffer.alloc(32, 4);
	const packet = encodeEncryptedFrame(key, 3n, {tag: 'text', body: 'private message'});
	assert.deepEqual(decodeEncryptedFrame(key, 3n, packet), {tag: 'text', body: 'private message'});
	assert.throws(() => decodeEncryptedFrame(key, 4n, packet), /AEAD|sequence/);
	assert.throws(() => decodeEncryptedFrame(Buffer.alloc(32, 5), 3n, packet), /AEAD/);
});

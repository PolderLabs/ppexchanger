import assert from 'node:assert/strict';
import test from 'node:test';
import {aeadDecrypt, aeadEncrypt, deriveNonce, generateX25519KeyPair, peerId, publicKeyFromSecret, x25519} from '../src/crypto.js';

test('x25519 derives the same shared secret from both sides', () => {
	const alice = generateX25519KeyPair();
	const bob = generateX25519KeyPair();
	assert.deepEqual(publicKeyFromSecret(alice.secretKey), alice.publicKey);
	assert.deepEqual(x25519(alice.secretKey, bob.publicKey), x25519(bob.secretKey, alice.publicKey));
	assert.equal(peerId(alice.publicKey).length, 32);
});

test('chacha20-poly1305 encrypts and authenticates payloads', () => {
	const key = Buffer.alloc(32, 9);
	const nonce = deriveNonce(key, 0n);
	const encrypted = aeadEncrypt(key, nonce, Buffer.from('hello'), Buffer.from('frame'));
	assert.equal(aeadDecrypt(key, nonce, encrypted, Buffer.from('frame')).toString(), 'hello');
	assert.throws(() => aeadDecrypt(key, nonce, encrypted, Buffer.from('tampered')), /auth|decrypt|Unsupported state/i);
});

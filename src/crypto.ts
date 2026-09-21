import {createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes} from 'node:crypto';

const PUBLIC_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PRIVATE_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function sha256(input: Uint8Array): Buffer {
	return createHash('sha256').update(input).digest();
}

export function hex(input: Uint8Array): string {
	return Buffer.from(input).toString('hex');
}

export function randomId(bytes = 16): string {
	return randomBytes(bytes).toString('hex');
}

export function generateX25519KeyPair(): {secretKey: Buffer; publicKey: Buffer} {
	const {privateKey, publicKey: generatedPublicKey} = generateKeyPairSync('x25519');
	return {secretKey: Buffer.from(privateKey.export({format: 'der', type: 'pkcs8'}).subarray(-32)), publicKey: Buffer.from(generatedPublicKey.export({format: 'der', type: 'spki'}).subarray(-32))};
}

export function publicKeyFromSecret(secretKey: Uint8Array): Buffer {
	const privateKey = createPrivateKey({key: Buffer.concat([PRIVATE_PREFIX, Buffer.from(secretKey)]), format: 'der', type: 'pkcs8'});
	return Buffer.from(createPublicKey(privateKey).export({format: 'der', type: 'spki'}).subarray(-32));
}

export function x25519(secretKey: Uint8Array, publicKey: Uint8Array): Buffer {
	const privateKey = createPrivateKey({key: Buffer.concat([PRIVATE_PREFIX, Buffer.from(secretKey)]), format: 'der', type: 'pkcs8'});
	const remoteKey = createPublicKey({key: Buffer.concat([PUBLIC_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki'});
	return diffieHellman({privateKey, publicKey: remoteKey});
}

export function fingerprint(publicKey: Uint8Array): string {
	return sha256(publicKey).subarray(0, 8).toString('hex');
}

export function peerId(publicKey: Uint8Array): string {
	return sha256(publicKey).subarray(0, 16).toString('hex');
}

export function deriveKey(secret: Uint8Array, salt: Uint8Array, info: string, length = 32): Buffer {
	return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from(salt), Buffer.from(info), length));
}

export function deriveNonce(key: Uint8Array, sequence: bigint): Buffer {
	const seq = Buffer.alloc(8);
	seq.writeBigUInt64BE(sequence);
	return deriveKey(key, Buffer.alloc(0), `ppexchanger-nonce:${seq.toString('hex')}`, 12);
}

export function transcriptMac(key: Uint8Array, transcript: Uint8Array): Buffer {
	return createHmac('sha256', key).update(transcript).digest();
}

export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad = Buffer.alloc(0)): Buffer {
	const cipher = createCipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(nonce), {authTagLength: 16});
	cipher.setAAD(Buffer.from(aad), {plaintextLength: plaintext.length});
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
	return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, payload: Uint8Array, aad = Buffer.alloc(0)): Buffer {
	const data = Buffer.from(payload);
	if (data.length < 16) throw new Error('encrypted payload is too short');
	const decipher = createDecipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(nonce), {authTagLength: 16});
	decipher.setAAD(Buffer.from(aad), {plaintextLength: data.length - 16});
	decipher.setAuthTag(data.subarray(-16));
	try {
		return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
	} catch {
		throw new Error('AEAD authentication failed');
	}
}

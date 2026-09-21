import {aeadDecrypt, aeadEncrypt, deriveKey, deriveNonce, hex, sha256} from './crypto.js';

export const DISCOVERY_PORT = 47391;
export const DISCOVERY_GROUP = '239.255.42.99';
export const MAX_FRAME = 64 * 1024;
const BEACON_MAGIC = Buffer.from('LANC');

export interface Beacon {
	peerId: string;
	publicKey: Buffer;
	tcpPort: number;
	name: string;
	hostname: string;
	controlPort: number;
}

export type Frame =
	| {tag: 'hello'; name: string; hostname: string}
	| {tag: 'text'; body: string}
	| {tag: 'bye'}
	| {tag: 'file-offer'; id: string; name: string; size: number; mime?: string}
	| {tag: 'file-accept'; id: string}
	| {tag: 'file-reject'; id: string}
	| {tag: 'file-chunk'; id: string; offset: number; data: Buffer}
	| {tag: 'file-done'; id: string};

function u16(value: number): Buffer {
	const out = Buffer.alloc(2);
	out.writeUInt16BE(value);
	return out;
}

function u32(value: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(value);
	return out;
}

function u64(value: number | bigint): Buffer {
	const out = Buffer.alloc(8);
	out.writeBigUInt64BE(BigInt(value));
	return out;
}

function readU16(input: Buffer, offset: number): number {
	if (offset + 2 > input.length) throw new Error('protocol truncated');
	return input.readUInt16BE(offset);
}

function readU32(input: Buffer, offset: number): number {
	if (offset + 4 > input.length) throw new Error('protocol truncated');
	return input.readUInt32BE(offset);
}

function readU64(input: Buffer, offset: number): number {
	if (offset + 8 > input.length) throw new Error('protocol truncated');
	const value = input.readBigUInt64BE(offset);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('protocol integer exceeds safe range');
	return Number(value);
}

function sizedString(value: string): Buffer {
	const bytes = Buffer.from(value, 'utf8');
	if (bytes.length > 0xffff) throw new Error('protocol string is too long');
	return Buffer.concat([u16(bytes.length), bytes]);
}

function readString(input: Buffer, offset: number): {value: string; next: number} {
	const length = readU16(input, offset);
	const start = offset + 2;
	const end = start + length;
	if (end > input.length) throw new Error('protocol string is truncated');
	return {value: input.subarray(start, end).toString('utf8'), next: end};
}

export function encodeBeacon(beacon: Beacon): Buffer {
	if (!beacon.name || beacon.tcpPort < 1 || beacon.tcpPort > 65535) throw new Error('invalid beacon');
	const peerId = Buffer.from(beacon.peerId, 'hex');
	if (peerId.length !== 16 || beacon.publicKey.length !== 32) throw new Error('invalid beacon identity');
	const body = Buffer.concat([peerId, beacon.publicKey, u16(beacon.tcpPort), sizedString(beacon.name), sizedString(beacon.hostname), u16(beacon.controlPort)]);
	const header = Buffer.concat([BEACON_MAGIC, Buffer.from([2, 1]), u16(body.length)]);
	const payload = Buffer.concat([header, body]);
	return Buffer.concat([payload, u32(crc32(payload))]);
}

export function decodeBeacon(input: Uint8Array): Beacon | undefined {
	const bytes = Buffer.from(input);
	if (bytes.length < 8 + 16 + 32 + 2 + 2 + 4 || bytes.length > 256) return undefined;
	if (!bytes.subarray(0, 4).equals(BEACON_MAGIC) || (bytes[4] !== 1 && bytes[4] !== 2) || bytes[5] !== 1) return undefined;
	const bodyLength = readU16(bytes, 6);
	if (bytes.length !== 8 + bodyLength + 4 || readU32(bytes, bytes.length - 4) !== crc32(bytes.subarray(0, -4))) return undefined;
	let offset = 8;
	const peerId = hex(bytes.subarray(offset, offset + 16)); offset += 16;
	const publicKey = bytes.subarray(offset, offset + 32); offset += 32;
	const tcpPort = readU16(bytes, offset); offset += 2;
	const name = readString(bytes, offset); offset = name.next;
	if (!name.value || tcpPort === 0) return undefined;
	let hostname = '';
	let controlPort = 0;
	if (bytes[4] === 2 && offset + 2 <= bytes.length - 4) {
		const host = readString(bytes, offset); offset = host.next; hostname = host.value;
		if (offset + 2 <= bytes.length - 4) controlPort = readU16(bytes, offset);
	}
	return {peerId, publicKey: Buffer.from(publicKey), tcpPort, name: name.value, hostname, controlPort};
}

export function encodeFrame(frame: Frame): Buffer {
	switch (frame.tag) {
		case 'bye': return Buffer.from([0]);
		case 'text': return Buffer.concat([Buffer.from([1]), Buffer.from(frame.body, 'utf8')]);
		case 'file-offer': return Buffer.concat([Buffer.from([2]), Buffer.from(frame.id, 'hex'), sizedString(frame.name), u64(frame.size), sizedString(frame.mime ?? '')]);
		case 'file-accept': return Buffer.concat([Buffer.from([3]), Buffer.from(frame.id, 'hex')]);
		case 'file-reject': return Buffer.concat([Buffer.from([4]), Buffer.from(frame.id, 'hex')]);
		case 'file-chunk': return Buffer.concat([Buffer.from([5]), Buffer.from(frame.id, 'hex'), u64(frame.offset), u32(frame.data.length), frame.data]);
		case 'file-done': return Buffer.concat([Buffer.from([6]), Buffer.from(frame.id, 'hex')]);
		case 'hello': return Buffer.concat([Buffer.from([7]), sizedString(frame.name), sizedString(frame.hostname)]);
	}
}

export function decodeFrame(input: Uint8Array): Frame {
	const bytes = Buffer.from(input);
	const tag = bytes[0];
	if (tag === undefined) throw new Error('empty frame');
	if (tag === 0) return {tag: 'bye'};
	if (tag === 1) return {tag: 'text', body: bytes.subarray(1).toString('utf8')};
	if (tag === 7) {
		const name = readString(bytes, 1);
		const hostname = readString(bytes, name.next);
		if (hostname.next !== bytes.length) throw new Error('hello has trailing bytes');
		return {tag: 'hello', name: name.value, hostname: hostname.value};
	}
	if (bytes.length < 17) throw new Error('frame is truncated');
	const id = hex(bytes.subarray(1, 17));
	if (tag === 3) return {tag: 'file-accept', id};
	if (tag === 4) return {tag: 'file-reject', id};
	if (tag === 6) return {tag: 'file-done', id};
	if (tag === 2) {
		const name = readString(bytes, 17);
		const size = readU64(bytes, name.next);
		const mime = readString(bytes, name.next + 8);
		if (mime.next !== bytes.length) throw new Error('file offer has trailing bytes');
		return mime.value ? {tag: 'file-offer', id, name: name.value, size, mime: mime.value} : {tag: 'file-offer', id, name: name.value, size};
	}
	if (tag === 5) {
		const offset = readU64(bytes, 17);
		const length = readU32(bytes, 25);
		const data = bytes.subarray(29);
		if (data.length !== length || data.length > 32 * 1024) throw new Error('file chunk is invalid');
		return {tag: 'file-chunk', id, offset, data: Buffer.from(data)};
	}
	throw new Error(`unknown frame tag ${tag}`);
}

export function encodeEncryptedFrame(key: Uint8Array, sequence: bigint, frame: Frame): Buffer {
	const plaintext = Buffer.concat([u64(sequence), encodeFrame(frame)]);
	const encrypted = aeadEncrypt(key, deriveNonce(key, sequence), plaintext);
	if (encrypted.length > MAX_FRAME) throw new Error('encrypted frame exceeds limit');
	return Buffer.concat([u32(encrypted.length), encrypted]);
}

export function decodeEncryptedFrame(key: Uint8Array, expectedSequence: bigint, input: Uint8Array): Frame {
	const bytes = Buffer.from(input);
	if (bytes.length < 4) throw new Error('encrypted frame is truncated');
	const length = readU32(bytes, 0);
	if (length < 16 || length > MAX_FRAME || bytes.length !== 4 + length) throw new Error('encrypted frame length is invalid');
	const plaintext = aeadDecrypt(key, deriveNonce(key, expectedSequence), bytes.subarray(4));
	if (plaintext.length < 9 || plaintext.readBigUInt64BE(0) !== expectedSequence) throw new Error('encrypted frame sequence mismatch');
	return decodeFrame(plaintext.subarray(8));
}

export function crc32(input: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function handshakeKey(sharedSecret: Uint8Array, transcript: Uint8Array): Buffer {
	return deriveKey(sharedSecret, sha256(transcript), 'ppexchanger-session', 64);
}

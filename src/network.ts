import {EventEmitter} from 'node:events';
import {createServer, connect as tcpConnect, type Server, type Socket} from 'node:net';
import {createSocket, type RemoteInfo, type Socket as UdpSocket} from 'node:dgram';
import {hostname} from 'node:os';
import {createReadStream} from 'node:fs';
import {mkdir, open, readdir, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fingerprint, generateX25519KeyPair, peerId, randomId, transcriptMac, x25519} from './crypto.js';
import {DISCOVERY_GROUP, DISCOVERY_PORT, decodeBeacon, decodeEncryptedFrame, encodeBeacon, encodeEncryptedFrame, type Beacon, type Frame, handshakeKey} from './protocol.js';
import {receivedDirectory, sanitizeFileName} from './storage.js';
import type {FileOffer, Identity, NetworkEvent, Peer, PeerId, PeerStatus} from './types.js';

const HANDSHAKE_MAGIC = Buffer.from('PPXT');
const HANDSHAKE_VERSION = 1;
const FRAME_TIMEOUT = 15_000;

type ConnectionKeys = {send: Buffer; receive: Buffer};
type OutboundTransfer = {peerId: PeerId; connection: Connection; path: string; name: string; size: number; mime?: string; resolve: () => void; reject: (error: Error) => void};
type InboundTransfer = {peerId: PeerId; connection: Connection; offer: FileOffer; path: string; handle: Awaited<ReturnType<typeof open>>; received: number};
type LocalDiscoveryRecord = {peerId: PeerId; name: string; hostname: string; port: number; publicKey: string; updatedAt: number};

class Reader {
	private buffer = Buffer.alloc(0);
	private waiting: Array<{length: number; resolve: (value: Buffer) => void; reject: (error: Error) => void}> = [];
	private ended?: Error;

	constructor(private readonly socket: Socket) {
		socket.on('data', chunk => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			this.flush();
		});
		socket.on('close', () => this.end(new Error('peer closed the connection')));
		socket.on('error', error => this.end(error));
	}

	read(length: number): Promise<Buffer> {
		if (this.buffer.length >= length) {
			const value = this.buffer.subarray(0, length);
			this.buffer = this.buffer.subarray(length);
			return Promise.resolve(value);
		}
		if (this.ended) return Promise.reject(this.ended);
		return new Promise((resolve, reject) => this.waiting.push({length, resolve, reject}));
	}

	private flush(): void {
		while (this.waiting[0] && this.buffer.length >= this.waiting[0].length) {
			const waiter = this.waiting.shift()!;
			const value = this.buffer.subarray(0, waiter.length);
			this.buffer = this.buffer.subarray(waiter.length);
			waiter.resolve(value);
		}
	}

	private end(error: Error): void {
		if (this.ended) return;
		this.ended = error;
		for (const waiter of this.waiting.splice(0)) waiter.reject(error);
	}
}

class Connection {
	private sendSequence = 0n;
	private receiveSequence = 0n;
	private closed = false;

	constructor(private readonly socket: Socket, private readonly keys: ConnectionKeys) {}
	get rawSocket(): Socket { return this.socket; }

	async send(frame: Frame): Promise<void> {
		if (this.closed) throw new Error('connection is closed');
		const packet = encodeEncryptedFrame(this.keys.send, this.sendSequence, frame);
		this.sendSequence++;
		await new Promise<void>((resolve, reject) => {
			this.socket.write(packet, error => error ? reject(error) : resolve());
		});
	}

	async read(reader: Reader): Promise<Frame> {
		const length = (await reader.read(4)).readUInt32BE(0);
		if (length < 16 || length > 64 * 1024) throw new Error('encrypted frame length is invalid');
		const payload = await reader.read(length);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(length);
		const frame = decodeEncryptedFrame(this.keys.receive, this.receiveSequence, Buffer.concat([header, payload]));
		this.receiveSequence++;
		return frame;
	}

	close(): void {
		this.closed = true;
		this.socket.destroy();
	}
}

function packet(kind: number, payload: Buffer): Buffer {
	const body = Buffer.concat([HANDSHAKE_MAGIC, Buffer.from([HANDSHAKE_VERSION, kind]), payload]);
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	return Buffer.concat([header, body]);
}

async function readPacket(reader: Reader): Promise<{kind: number; payload: Buffer}> {
	const length = (await reader.read(4)).readUInt32BE(0);
	if (length < 6 || length > 4096) throw new Error('handshake packet length is invalid');
	const body = await reader.read(length);
	if (!body.subarray(0, 4).equals(HANDSHAKE_MAGIC) || body[4] !== HANDSHAKE_VERSION) throw new Error('handshake version mismatch');
	return {kind: body[5]!, payload: body.subarray(6)};
}

function deriveConnectionKeys(identity: Identity, remoteStatic: Buffer, localEphemeral: Buffer, remoteEphemeral: Buffer, localEphemeralSecret: Buffer, initiator: boolean): ConnectionKeys {
	const secrets = initiator ? Buffer.concat([
		x25519(localEphemeralSecret, remoteEphemeral),
		x25519(localEphemeralSecret, remoteStatic),
		x25519(identity.secretKey, remoteEphemeral),
		x25519(identity.secretKey, remoteStatic)
	]) : Buffer.concat([
		x25519(localEphemeralSecret, remoteEphemeral),
		x25519(identity.secretKey, remoteEphemeral),
		x25519(localEphemeralSecret, remoteStatic),
		x25519(identity.secretKey, remoteStatic)
	]);
	const transcript = initiator
		? Buffer.concat([HANDSHAKE_MAGIC, identity.publicKey, localEphemeral, remoteStatic, remoteEphemeral])
		: Buffer.concat([HANDSHAKE_MAGIC, remoteStatic, remoteEphemeral, identity.publicKey, localEphemeral]);
	const material = handshakeKey(secrets, transcript);
	return initiator ? {send: material.subarray(0, 32), receive: material.subarray(32, 64)} : {send: material.subarray(32, 64), receive: material.subarray(0, 32)};
}

async function handshakeAsInitiator(socket: Socket, identity: Identity): Promise<{connection: Connection; remoteStatic: Buffer; reader: Reader}> {
	const reader = new Reader(socket);
	const ephemeral = generateX25519KeyPair();
	await writePacket(socket, packet(1, Buffer.concat([identity.publicKey, ephemeral.publicKey])));
	const response = await readPacket(reader);
	if (response.kind !== 2 || response.payload.length !== 64 + 32) throw new Error('invalid handshake response');
	const remoteStatic = response.payload.subarray(0, 32);
	const remoteEphemeral = response.payload.subarray(32, 64);
	const keys = deriveConnectionKeys(identity, remoteStatic, ephemeral.publicKey, remoteEphemeral, ephemeral.secretKey, true);
	const transcript = Buffer.concat([HANDSHAKE_MAGIC, identity.publicKey, ephemeral.publicKey, remoteStatic, remoteEphemeral]);
	const proof = transcriptMac(keys.send, transcript);
	if (!response.payload.subarray(64).equals(proof)) throw new Error('peer handshake proof failed');
	await writePacket(socket, packet(3, transcriptMac(keys.receive, transcript)));
	return {connection: new Connection(socket, keys), remoteStatic: Buffer.from(remoteStatic), reader};
}

async function handshakeAsResponder(socket: Socket, identity: Identity): Promise<{connection: Connection; remoteStatic: Buffer; reader: Reader}> {
	const reader = new Reader(socket);
	const request = await readPacket(reader);
	if (request.kind !== 1 || request.payload.length !== 64) throw new Error('invalid handshake request');
	const remoteStatic = request.payload.subarray(0, 32);
	const remoteEphemeral = request.payload.subarray(32, 64);
	const ephemeral = generateX25519KeyPair();
	const keys = deriveConnectionKeys(identity, remoteStatic, ephemeral.publicKey, remoteEphemeral, ephemeral.secretKey, false);
	// Responder derives the same transcript ordering as the initiator.
	const initiatorTranscript = Buffer.concat([HANDSHAKE_MAGIC, remoteStatic, remoteEphemeral, identity.publicKey, ephemeral.publicKey]);
	await writePacket(socket, packet(2, Buffer.concat([identity.publicKey, ephemeral.publicKey, transcriptMac(keys.receive, initiatorTranscript)])));
	const proof = await readPacket(reader);
	if (proof.kind !== 3 || !proof.payload.equals(transcriptMac(keys.send, initiatorTranscript))) throw new Error('initiator handshake proof failed');
	return {connection: new Connection(socket, keys), remoteStatic: Buffer.from(remoteStatic), reader};
}

function writePacket(socket: Socket, data: Buffer): Promise<void> {
	return new Promise((resolve, reject) => socket.write(data, error => error ? reject(error) : resolve()));
}

function peerFromBeacon(beacon: Beacon, address: string): Peer {
	return {peerId: beacon.peerId, name: beacon.name, hostname: beacon.hostname, address, port: beacon.tcpPort, publicKey: beacon.publicKey, fingerprint: fingerprint(beacon.publicKey), status: 'discovered', trusted: false, lastSeen: Date.now()};
}

export class NetworkService extends EventEmitter {
	private readonly tcpServer: Server;
	private readonly udp: UdpSocket;
	private readonly connections = new Map<PeerId, Connection>();
	private readonly peers = new Map<PeerId, Peer>();
	private readonly outboundTransfers = new Map<string, OutboundTransfer>();
	private readonly inboundTransfers = new Map<string, InboundTransfer>();
	private announceTimer?: NodeJS.Timeout;
	private localDiscoveryTimer?: NodeJS.Timeout;
	private readonly localDiscoveryDirectory: string;
	private readonly localDiscoveryPath: string;
	private tcpPort = 0;
	private tcpStarted = false;
	private udpStarted = false;

	constructor(private readonly identity: Identity, private readonly requestedPort = DISCOVERY_PORT, private readonly dataDirectory = process.cwd()) {
		super();
		this.localDiscoveryDirectory = join(tmpdir(), `ppexchanger-discovery-${process.getuid?.() ?? process.env.USER ?? 'user'}`);
		this.localDiscoveryPath = join(this.localDiscoveryDirectory, `${this.identity.peerId}.json`);
		this.tcpServer = createServer(socket => void this.accept(socket));
		this.udp = createSocket({type: 'udp4', reuseAddr: true});
		this.udp.on('message', (message, remote) => this.onBeacon(message, remote));
		this.udp.on('error', error => this.emitStatus(`Discovery unavailable: ${error.message}`));
	}

	get localPort(): number { return this.tcpPort; }
	get currentPeers(): Peer[] { return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name)); }

	async discoverNow(): Promise<Peer[]> {
		if (!this.tcpStarted || !this.udpStarted) throw new Error('discovery is not running');
		await this.writeLocalDiscoveryRecord();
		await this.announce();
		await this.refreshLocalDiscovery();
		await new Promise<void>(resolve => setTimeout(resolve, 250));
		await this.refreshLocalDiscovery();
		return this.currentPeers;
	}

	rememberPeer(peer: Peer): void {
		const existing = this.peers.get(peer.peerId);
		this.peers.set(peer.peerId, {...peer, trusted: existing?.trusted ?? peer.trusted});
		this.emit('event', {type: 'peer', peer: this.peers.get(peer.peerId)!} satisfies NetworkEvent);
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.tcpServer.once('error', reject);
			this.tcpServer.listen(this.requestedPort, '0.0.0.0', () => {
				this.tcpPort = (this.tcpServer.address() as {port: number}).port;
				this.tcpStarted = true;
				resolve();
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.udp.once('error', reject);
			this.udp.bind(DISCOVERY_PORT, '0.0.0.0', () => {
				try {
					this.udp.addMembership(DISCOVERY_GROUP);
					this.udp.setMulticastTTL(1);
					this.udpStarted = true;
					resolve();
				} catch (error) { reject(error); }
			});
		});
		await this.writeLocalDiscoveryRecord();
		await this.announce();
		this.announceTimer = setInterval(() => void this.announce(), 10_000);
		this.localDiscoveryTimer = setInterval(() => void this.refreshLocalDiscovery(), 1_000);
		void this.refreshLocalDiscovery();
	}

	async stop(): Promise<void> {
		if (this.announceTimer) clearInterval(this.announceTimer);
		if (this.localDiscoveryTimer) clearInterval(this.localDiscoveryTimer);
		await unlink(this.localDiscoveryPath).catch(() => undefined);
		if (this.udpStarted) {
			this.udp.close();
			this.udpStarted = false;
		}
		for (const connection of this.connections.values()) connection.close();
		if (this.tcpStarted) {
			await new Promise<void>(resolve => this.tcpServer.close(() => resolve()));
			this.tcpStarted = false;
		}
	}

	async connect(peer: PeerId): Promise<void> {
		const target = this.peers.get(peer);
		if (!target || this.connections.has(peer)) return;
		this.setPeerStatus(peer, 'connecting');
		let socket: Socket | undefined;
		try {
			socket = await new Promise<Socket>((resolve, reject) => {
				const candidate = tcpConnect({host: target.address, port: target.port});
				candidate.setTimeout(FRAME_TIMEOUT, () => candidate.destroy(new Error('connection timed out')));
				candidate.once('connect', () => resolve(candidate));
				candidate.once('error', reject);
			});
			const result = await handshakeAsInitiator(socket, this.identity);
			if (!result.remoteStatic.equals(target.publicKey)) throw new Error('peer key changed; refusing to connect');
			await this.attach(peer, target, result.connection, result.reader);
		} catch (error) {
			socket?.destroy();
			this.setPeerStatus(peer, 'offline');
			this.emitStatus(`${target.name} is not reachable right now`);
			throw error;
		}
	}

	async sendText(peer: PeerId, body: string): Promise<void> {
		const connection = this.connections.get(peer);
		if (!connection) throw new Error('peer is not connected');
		await connection.send({tag: 'text', body});
	}

	async sendFile(peer: PeerId, path: string): Promise<void> {
		const connection = this.connections.get(peer);
		if (!connection) throw new Error('peer is not connected');
		const file = await stat(path);
		if (!file.isFile()) throw new Error('path is not a regular file');
		const id = randomId();
		const name = sanitizeFileName(path.split(/[\\/]/).pop() ?? 'attachment');
		const mime = mimeFor(name);
		await connection.send({tag: 'file-offer', id, name, size: file.size, ...(mime ? {mime} : {})});
		await new Promise<void>((resolve, reject) => {
			this.outboundTransfers.set(id, {peerId: peer, connection, path, name, size: file.size, ...(mime ? {mime} : {}), resolve, reject});
			setTimeout(() => {
				const pending = this.outboundTransfers.get(id);
				if (pending) {
					this.outboundTransfers.delete(id);
					reject(new Error('file offer timed out'));
				}
			}, 30_000).unref();
		});
	}

	async acceptFile(peer: PeerId, offer: FileOffer): Promise<void> {
		const connection = this.connections.get(peer);
		if (!connection) throw new Error('peer is not connected');
		const directory = receivedDirectory(this.dataDirectory);
		await mkdir(directory, {recursive: true, mode: 0o700});
		const path = join(directory, `${offer.id}-${sanitizeFileName(offer.name)}`);
		const handle = await open(path, 'wx');
		this.inboundTransfers.set(offer.id, {peerId: peer, connection, offer, path, handle, received: 0});
		await connection.send({tag: 'file-accept', id: offer.id});
	}

	async rejectFile(peer: PeerId, offer: FileOffer): Promise<void> {
		const connection = this.connections.get(peer);
		if (connection) await connection.send({tag: 'file-reject', id: offer.id});
	}

	private async announce(): Promise<void> {
		try {
			const message = encodeBeacon({peerId: this.identity.peerId, publicKey: this.identity.publicKey, tcpPort: this.tcpPort, name: this.identity.name, hostname: hostname(), controlPort: 0});
			await new Promise<void>((resolve, reject) => this.udp.send(message, DISCOVERY_PORT, DISCOVERY_GROUP, error => error ? reject(error) : resolve()));
		} catch (error) {
			this.emitStatus(`Could not announce on the LAN: ${(error as Error).message}`);
		}
	}

	private async writeLocalDiscoveryRecord(): Promise<void> {
		await mkdir(this.localDiscoveryDirectory, {recursive: true, mode: 0o700});
		const record: LocalDiscoveryRecord = {
			peerId: this.identity.peerId,
			name: this.identity.name,
			hostname: hostname(),
			port: this.tcpPort,
			publicKey: this.identity.publicKey.toString('base64'),
			updatedAt: Date.now()
		};
		const temporary = `${this.localDiscoveryPath}.${process.pid}.tmp`;
		await writeFile(temporary, JSON.stringify(record), {mode: 0o600});
		await rename(temporary, this.localDiscoveryPath);
	}

	private async refreshLocalDiscovery(): Promise<void> {
		try {
			await this.writeLocalDiscoveryRecord();
			const entries = await readdir(this.localDiscoveryDirectory, {withFileTypes: true});
			const cutoff = Date.now() - 15_000;
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === `${this.identity.peerId}.json`) continue;
				const path = join(this.localDiscoveryDirectory, entry.name);
				let record: LocalDiscoveryRecord;
				try {
					record = JSON.parse(await readFile(path, 'utf8')) as LocalDiscoveryRecord;
				} catch {
					continue;
				}
				if (record.updatedAt < cutoff || record.peerId === this.identity.peerId || !record.publicKey || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) {
					if (record.updatedAt < cutoff) await unlink(path).catch(() => undefined);
					continue;
				}
				const publicKey = Buffer.from(record.publicKey, 'base64');
				if (publicKey.length !== 32) continue;
				const existing = this.peers.get(record.peerId);
				const peer: Peer = {
					peerId: record.peerId,
					name: record.name,
					hostname: record.hostname,
					address: '127.0.0.1',
					port: record.port,
					publicKey,
					fingerprint: fingerprint(publicKey),
					status: this.connections.has(record.peerId) ? 'connected' : existing?.status === 'connecting' ? 'connecting' : 'discovered',
					trusted: existing?.trusted ?? false,
					lastSeen: record.updatedAt
				};
				this.peers.set(record.peerId, peer);
				this.emit('event', {type: 'peer', peer} satisfies NetworkEvent);
			}
		} catch (error) {
			this.emitStatus(`Local discovery unavailable: ${(error as Error).message}`);
		}
	}

	private onBeacon(message: Buffer, remote: RemoteInfo): void {
		const beacon = decodeBeacon(message);
		if (!beacon || beacon.peerId === this.identity.peerId) return;
		const peer = peerFromBeacon(beacon, remote.address);
		const existing = this.peers.get(peer.peerId);
		peer.trusted = existing?.trusted ?? false;
		peer.status = this.connections.has(peer.peerId) ? 'connected' : existing?.status === 'connecting' ? 'connecting' : 'discovered';
		this.peers.set(peer.peerId, peer);
		this.emit('event', {type: 'peer', peer} satisfies NetworkEvent);
	}

	private async accept(socket: Socket): Promise<void> {
		socket.setTimeout(FRAME_TIMEOUT, () => socket.destroy());
		try {
			const result = await handshakeAsResponder(socket, this.identity);
			const id = peerId(result.remoteStatic);
			const existing = this.peers.get(id);
			if (existing && !existing.publicKey.equals(result.remoteStatic)) throw new Error('peer key changed; refusing connection');
			const address = socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown';
			const peer: Peer = existing ?? {peerId: id, name: `peer-${id.slice(0, 6)}`, hostname: '', address, port: socket.remotePort ?? 0, publicKey: result.remoteStatic, fingerprint: fingerprint(result.remoteStatic), status: 'connected', trusted: false, lastSeen: Date.now()};
			peer.status = 'connected';
			peer.lastSeen = Date.now();
			this.peers.set(id, peer);
			await this.attach(id, peer, result.connection, result.reader);
		} catch {
			socket.destroy();
		}
	}

	private async attach(id: PeerId, peer: Peer, connection: Connection, reader: Reader): Promise<void> {
		connection.rawSocket.setTimeout(0);
		connection.rawSocket.setKeepAlive(true, 5_000);
		connection.rawSocket.setNoDelay(true);
		this.connections.set(id, connection);
		this.setPeerStatus(id, 'connected');
		await connection.send({tag: 'hello', name: this.identity.name, hostname: hostname()});
		void this.readLoop(id, peer, connection, reader);
	}

	private async readLoop(id: PeerId, peer: Peer, connection: Connection, reader: Reader): Promise<void> {
		try {
			while (this.connections.get(id) === connection) {
				const frame = await connection.read(reader);
				if (frame.tag === 'hello') {
					peer.name = frame.name || peer.name;
					peer.hostname = frame.hostname;
					this.emit('event', {type: 'peer', peer} satisfies NetworkEvent);
				} else if (frame.tag === 'text') {
					this.emit('event', {type: 'message', peerId: id, body: frame.body, direction: 'incoming'} satisfies NetworkEvent);
				} else if (frame.tag === 'file-offer') {
						this.emit('event', {type: 'file-offer', peerId: id, offer: {id: frame.id, name: frame.name, size: frame.size, ...(frame.mime ? {mime: frame.mime} : {})}} satisfies NetworkEvent);
				} else if (frame.tag === 'file-accept') {
					const transfer = this.outboundTransfers.get(frame.id);
					if (transfer) void this.streamFile(frame.id, transfer);
				} else if (frame.tag === 'file-reject') {
					const transfer = this.outboundTransfers.get(frame.id);
					if (transfer) {
						this.outboundTransfers.delete(frame.id);
						transfer.reject(new Error('peer rejected the file'));
					}
				} else if (frame.tag === 'file-chunk') {
					await this.receiveChunk(frame.id, frame.offset, frame.data);
				} else if (frame.tag === 'file-done') {
					await this.finishIncoming(frame.id);
				} else if (frame.tag === 'bye') break;
			}
		} catch (error) {
			if (this.connections.get(id) === connection) this.emitStatus(`${peer.name} disconnected`);
		}
		if (this.connections.get(id) === connection) {
			this.connections.delete(id);
			this.setPeerStatus(id, 'offline');
		}
		for (const [transferId, transfer] of this.outboundTransfers) {
			if (transfer.peerId === id) {
				this.outboundTransfers.delete(transferId);
				transfer.reject(new Error('peer disconnected during file transfer'));
			}
		}
		for (const [transferId, transfer] of this.inboundTransfers) {
			if (transfer.peerId === id) {
				this.inboundTransfers.delete(transferId);
				await transfer.handle.close();
			}
		}
	}

	private async streamFile(id: string, transfer: OutboundTransfer): Promise<void> {
		try {
			let offset = 0;
			for await (const chunk of createReadStream(transfer.path, {highWaterMark: 32 * 1024})) {
				const data = Buffer.from(chunk as Uint8Array);
				await transfer.connection.send({tag: 'file-chunk', id, offset, data});
				offset += data.length;
			}
			await transfer.connection.send({tag: 'file-done', id});
			this.outboundTransfers.delete(id);
			transfer.resolve();
			this.emit('event', {type: 'file-sent', peerId: transfer.peerId, name: transfer.name, path: transfer.path, size: transfer.size, ...(transfer.mime ? {mime: transfer.mime} : {})} satisfies NetworkEvent);
		} catch (error) {
			this.outboundTransfers.delete(id);
			transfer.reject(error as Error);
		}
	}

	private async receiveChunk(id: string, offset: number, data: Buffer): Promise<void> {
		const transfer = this.inboundTransfers.get(id);
		if (!transfer || offset !== transfer.received) throw new Error('unexpected file chunk');
		if (transfer.received + data.length > transfer.offer.size) throw new Error('file exceeds offered size');
		await transfer.handle.write(data, 0, data.length, offset);
		transfer.received += data.length;
	}

	private async finishIncoming(id: string): Promise<void> {
		const transfer = this.inboundTransfers.get(id);
		if (!transfer) throw new Error('unknown file transfer');
		this.inboundTransfers.delete(id);
		await transfer.handle.close();
		if (transfer.received !== transfer.offer.size) throw new Error('received file size does not match offer');
		this.emit('event', {type: 'file-received', peerId: transfer.peerId, name: transfer.offer.name, path: transfer.path, size: transfer.received, ...(transfer.offer.mime ? {mime: transfer.offer.mime} : {})} satisfies NetworkEvent);
	}

	private setPeerStatus(peerIdValue: PeerId, status: PeerStatus): void {
		const peer = this.peers.get(peerIdValue);
		if (peer) {
			peer.status = status;
			this.emit('event', {type: 'peer-status', peerId: peerIdValue, status} satisfies NetworkEvent);
		}
	}

	private emitStatus(message: string): void {
		this.emit('event', {type: 'status', message} satisfies NetworkEvent);
	}
}

function mimeFor(name: string): string | undefined {
	const extension = name.toLowerCase().split('.').pop();
	return extension === 'txt' || extension === 'md' || extension === 'log' ? 'text/plain' : extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : undefined;
}

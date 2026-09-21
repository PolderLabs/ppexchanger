import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir, hostname} from 'node:os';
import {join} from 'node:path';
import {fingerprint, generateX25519KeyPair, peerId, publicKeyFromSecret} from './crypto.js';
import type {Identity, Message, Peer, PeerRecord, StoredState, UiSettings} from './types.js';

export const MESSAGE_PAGE_SIZE = 40;

export const defaultUiSettings = (): UiSettings => ({
	theme: 'amber',
	showSidebar: true,
	compactMode: true,
	showHints: true,
	notifications: true,
	maxMessages: 1000,
	showFooter: true,
	statusFormat: 'name',
	scrollback: 500,
	sidebarBreakpoint: 80,
	minChatWidth: 40,
	notifySound: false,
	desktopNotifications: true,
	imagePreviews: true,
	autoTrustSeen: false
});

export function configDirectory(override?: string): string {
	if (override) return override;
	if (process.env.PPX_CONFIG_DIR) return process.env.PPX_CONFIG_DIR;
	if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ppexchanger');
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ppexchanger');
}

export async function ensureConfigDirectory(directory: string): Promise<void> {
	await mkdir(directory, {recursive: true, mode: 0o700});
}

async function atomicWrite(path: string, data: string): Promise<void> {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, data, {mode: 0o600});
	await rename(temporary, path);
}

export async function loadState(directory: string, nameOverride?: string): Promise<{identity: Identity; peers: Peer[]; messages: Message[]; messageCounts: Record<string, number>; settings: UiSettings}> {
	await ensureConfigDirectory(directory);
	const path = join(directory, 'state.json');
	let stored: StoredState | undefined;
	try {
		stored = JSON.parse(await readFile(path, 'utf8')) as StoredState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const secretKey = stored?.identity.secretKey ? Buffer.from(stored.identity.secretKey, 'base64') : generateX25519KeyPair().secretKey;
	if (secretKey.length !== 32) throw new Error('stored identity key is invalid');
	const publicKey = publicKeyFromSecret(secretKey);
	const identity: Identity = {
		name: nameOverride?.trim() || stored?.identity.name || `${hostname()} user`,
		secretKey,
		publicKey,
		peerId: peerId(publicKey),
		fingerprint: fingerprint(publicKey)
	};
	const peers = (stored?.peers ?? []).map(record => ({...record, publicKey: Buffer.from(record.publicKey, 'base64'), status: 'offline' as const}));
	const storedMessages = (stored?.messages ?? []).map(normalizeStoredMessage);
	const messageCounts = countMessagesByPeer(storedMessages);
	const messages = recentMessagesByPeer(storedMessages, MESSAGE_PAGE_SIZE);
	const settings = {...defaultUiSettings(), ...(stored?.settings ?? {})};
	await saveState(directory, identity, peers, storedMessages, settings);
	return {identity, peers, messages, messageCounts, settings};
}

export async function loadMessagePage(directory: string, peerId: string, beforeId: string | undefined, limit = MESSAGE_PAGE_SIZE): Promise<{messages: Message[]; remaining: number; total: number}> {
	let stored: StoredState;
	try {
		stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as StoredState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {messages: [], remaining: 0, total: 0};
		throw error;
	}
	const conversation = (stored.messages ?? []).map(normalizeStoredMessage).filter(message => message.peerId === peerId);
	const beforeIndex = beforeId ? conversation.findIndex(message => message.id === beforeId) : conversation.length;
	const end = beforeIndex < 0 ? conversation.length : beforeIndex;
	const start = Math.max(0, end - Math.max(1, limit));
	return {messages: conversation.slice(start, end), remaining: start, total: conversation.length};
}

export async function saveState(directory: string, identity: Identity, peers: Peer[], messages: Message[], settings: UiSettings = defaultUiSettings()): Promise<void> {
	await ensureConfigDirectory(directory);
	let existingMessages: Message[] = [];
	try {
		const existing = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as StoredState;
		existingMessages = existing.messages ?? [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const mergedMessages = new Map(existingMessages.map(message => [message.id, message]));
	for (const message of messages) mergedMessages.set(message.id, message);
	const history = [...mergedMessages.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-settings.maxMessages);
	const stored: StoredState = {
		version: 1,
		identity: {name: identity.name, secretKey: identity.secretKey.toString('base64')},
		peers: peers.map((peer): PeerRecord => ({
			peerId: peer.peerId,
			name: peer.name,
			hostname: peer.hostname,
			address: peer.address,
			port: peer.port,
			publicKey: peer.publicKey.toString('base64'),
			fingerprint: peer.fingerprint,
			trusted: peer.trusted,
			lastSeen: peer.lastSeen
		})),
		messages: history,
		settings
	};
	await atomicWrite(join(directory, 'state.json'), `${JSON.stringify(stored, null, 2)}\n`);
}

function countMessagesByPeer(messages: Message[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const message of messages) counts[message.peerId] = (counts[message.peerId] ?? 0) + 1;
	return counts;
}

function recentMessagesByPeer(messages: Message[], limit: number): Message[] {
	const counts: Record<string, number> = {};
	const recent: Message[] = [];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		const count = counts[message.peerId] ?? 0;
		if (count >= limit) continue;
		counts[message.peerId] = count + 1;
		recent.push(message);
	}
	return recent.reverse();
}

function normalizeStoredMessage(message: Message): Message {
	if (message.kind !== 'file' || message.direction !== 'system') return message;
	if (/^Sent\s/i.test(message.body)) return {...message, direction: 'outgoing'};
	if (/^Received\s/i.test(message.body)) return {...message, direction: 'incoming'};
	return message;
}

export function receivedDirectory(directory: string): string {
	return join(directory, 'received');
}

export function sanitizeFileName(input: string): string {
	const value = input.replaceAll(/[^a-zA-Z0-9._ -]/g, '_').replaceAll('..', '_').trim();
	return value || 'attachment';
}

export function pathWithin(parent: string, child: string): boolean {
	return child === parent || child.startsWith(`${parent}/`);
}

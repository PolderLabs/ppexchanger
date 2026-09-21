import {spawn} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, measureElement, Text, useApp, useInput, useStdin, useStdout, useWindowSize} from 'ink';
import type {DOMElement} from 'ink';
import {Select} from '@inkjs/ui';
import {NetworkService} from './network.js';
import {defaultUiSettings, loadMessagePage, MESSAGE_PAGE_SIZE, saveState} from './storage.js';
import type {FileOffer, Identity, Message, NetworkEvent, Peer, PeerId, ThemeName, UiSettings} from './types.js';

interface AppProps {
	identity: Identity;
	directory: string;
	peers: Peer[];
	messages: Message[];
	messageCounts: Record<string, number>;
	settings: UiSettings;
	network: NetworkService;
}

interface Palette {
	background: string;
	accent: string;
	text: string;
	muted: string;
	dim: string;
	border: string;
	strongBorder: string;
	overlay: string;
	success: string;
	warning: string;
	error: string;
}

type View = 'chat' | 'settings' | 'help';
type Focus = 'sidebar' | 'chat' | 'composer';
type SettingTab = 'profile' | 'appearance' | 'chat' | 'privacy' | 'about';
type SettingId = 'name' | 'theme' | 'sidebar' | 'compact' | 'hints' | 'footer' | 'statusFormat' | 'sidebarBreakpoint' | 'minChatWidth' | 'scrollback' | 'notifications' | 'notifySound' | 'desktopNotifications' | 'imagePreviews' | 'autoTrustSeen' | 'maxMessages' | 'reset';
type ContextAction = 'copy-message' | 'open-file' | 'reveal-file' | 'connect-peer' | 'trust-peer' | 'revoke-peer' | 'remove-peer' | 'focus-composer' | 'clear-draft' | 'open-settings';
type ContextTarget = {kind: 'message'; messageId: string} | {kind: 'peer'; peerId: PeerId} | {kind: 'composer'} | {kind: 'chat'};
type ContextMenuState = {x: number; y: number; target: ContextTarget};
type ContextItem = {label: string; hint: string; action: ContextAction};
interface CommandItem {
	command: string;
	description: string;
}

type ElementRef = React.MutableRefObject<DOMElement | null>;
type Rect = {x: number; y: number; width: number; height: number};
type RefTarget = DOMElement | null | ElementRef;
type Attachment = {path: string; name: string};
type DataImage = {mime: string; extension: string; bytes: Buffer};
type ClipboardPayload = {kind: 'text'; value: string} | {kind: 'image'; data: DataImage};
type FileViewerState = {kind: 'image' | 'text' | 'file'; path: string; name: string; mime?: string; lines?: string[]; scroll: number; column: number; loading?: boolean; error?: string};
type MessageSegment = {kind: 'text'; lines: string[]} | {kind: 'code'; language: string; code: string; lines: string[]};

const KITTY_BACKDROP_IMAGE_ID = 0x505058;
const KITTY_BACKDROP_Z_INDEX = -2147483648;

const palettes: Record<ThemeName, Palette> = {
	amber: {
		background: '#10171a',
		accent: '#f0b35b',
		text: '#f0eee8',
		muted: '#b7b9b4',
		dim: '#8d999c',
		border: '#56666d',
		strongBorder: '#a9b8bd',
		overlay: '#10171a',
		success: '#88c9a1',
		warning: '#f0b35b',
		error: '#e78383'
	},
	ocean: {
		background: '#0d1b20',
		accent: '#67c7d8',
		text: '#e5f2f3',
		muted: '#a8c0c5',
		dim: '#87a2a8',
		border: '#4e7079',
		strongBorder: '#9bd1d8',
		overlay: '#0d1b20',
		success: '#82d6ad',
		warning: '#e8bf74',
		error: '#ef8f98'
	},
	mono: {
		background: '#111111',
		accent: '#ffffff',
		text: '#e8e8e8',
		muted: '#b5b5b5',
		dim: '#9e9e9e',
		border: '#858585',
		strongBorder: '#c8c8c8',
		overlay: '#111111',
		success: '#c8c8c8',
		warning: '#ffffff',
		error: '#d0d0d0'
	}
};

const settingsTabs: Array<{id: SettingTab; label: string}> = [
	{id: 'profile', label: 'Profile'},
	{id: 'appearance', label: 'Appearance'},
	{id: 'chat', label: 'Chat'},
	{id: 'privacy', label: 'Privacy'},
	{id: 'about', label: 'About'}
];

type SettingRow = {id: SettingId; label: string; section: string};
const settingRowsByTab: Record<SettingTab, SettingRow[]> = {
	profile: [{id: 'name', label: 'Display name', section: 'Identity'}],
	appearance: [
		{id: 'theme', label: 'Color theme', section: 'Theme'},
		{id: 'sidebar', label: 'Show sidebar', section: 'Layout'},
		{id: 'compact', label: 'Compact messages', section: 'Layout'},
		{id: 'footer', label: 'Show footer', section: 'Layout'},
		{id: 'statusFormat', label: 'Status format', section: 'Status'},
		{id: 'sidebarBreakpoint', label: 'Sidebar breakpoint', section: 'Responsive layout'},
		{id: 'minChatWidth', label: 'Minimum chat width', section: 'Responsive layout'}
	],
	chat: [
		{id: 'hints', label: 'Keyboard hints', section: 'Composer'},
		{id: 'scrollback', label: 'Scrollback limit', section: 'History'},
		{id: 'maxMessages', label: 'Stored messages', section: 'History'},
		{id: 'notifications', label: 'Notifications', section: 'Notifications'},
		{id: 'notifySound', label: 'Terminal bell', section: 'Notifications'},
		{id: 'desktopNotifications', label: 'Desktop notifications', section: 'Notifications'},
		{id: 'imagePreviews', label: 'Image previews', section: 'Media'}
	],
	privacy: [
		{id: 'autoTrustSeen', label: 'Auto-trust discovered peers', section: 'Trust'},
		{id: 'reset', label: 'Reset UI settings', section: 'Danger zone'}
	],
	about: []
};

const commandCatalog: CommandItem[] = [
	{command: '/help', description: 'show keyboard help'},
	{command: '/settings', description: 'open preferences'},
	{command: '/peers', description: 'list known peers'},
	{command: '/discover', description: 'show LAN discovery status'},
	{command: '/connect', description: 'connect to a peer'},
	{command: '/name', description: 'change your display name'},
	{command: '/send', description: 'send a file'},
	{command: '/trust', description: 'trust the selected peer'},
	{command: '/revoke', description: 'revoke peer trust'},
	{command: '/quit', description: 'exit ppx'}
];

export function App({identity, directory, peers: initialPeers, messages: initialMessages, messageCounts: initialMessageCounts, settings: initialSettings, network}: AppProps): React.JSX.Element {
	const {exit} = useApp();
	const {stdin, isRawModeSupported} = useStdin();
	const {stdout} = useStdout();
	const {columns, rows} = useWindowSize();
	const [peers, setPeers] = useState(initialPeers);
	const [messages, setMessages] = useState(initialMessages);
	const [messageCounts, setMessageCounts] = useState(initialMessageCounts);
	const [historyLoadingPeerId, setHistoryLoadingPeerId] = useState<PeerId>();
	const [settings, setSettings] = useState(initialSettings);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [composer, setComposer] = useState('');
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [composerVersion, setComposerVersion] = useState(0);
	const [status, setStatus] = useState('Discovery is listening for nearby peers');
	const [view, setView] = useState<View>('chat');
	const [focus, setFocus] = useState<Focus>('composer');
	const [selectedPeerId, setSelectedPeerId] = useState<PeerId>();
	const removedPeerIds = useRef(new Set<PeerId>());
	const connectingPeerIds = useRef(new Set<PeerId>());
	const [discoveryOpen, setDiscoveryOpen] = useState(false);
	const [discovering, setDiscovering] = useState(false);
	const [removePeerConfirm, setRemovePeerConfirm] = useState<Peer>();
	const [contextMenu, setContextMenu] = useState<ContextMenuState>();
	const [contextMenuIndex, setContextMenuIndex] = useState(0);
	const [settingsTab, setSettingsTab] = useState<SettingTab>('profile');
	const [settingsIndex, setSettingsIndex] = useState(0);
	const [editingName, setEditingName] = useState(false);
	const [nameDraft, setNameDraft] = useState(identity.name);
	const [chatScroll, setChatScroll] = useState(0);
	const chatScrollRef = useRef(0);
	const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(() => new Set());
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [pendingOffer, setPendingOffer] = useState<{peerId: PeerId; offer: FileOffer}>();
	const [fileViewer, setFileViewer] = useState<FileViewerState>();
	const mouseBuffer = useRef('');
	const mouseHandler = useRef<((x: number, y: number, button: number) => void) | undefined>(undefined);
	const handledMouse = useRef(new Map<string, number>());
	const mouseEscapePending = useRef(false);
	const wordDeletePending = useRef(false);
	const wordDeleteTimer = useRef<NodeJS.Timeout | undefined>(undefined);
	const settingsActionRef = useRef<DOMElement | null>(null);
	const helpActionRef = useRef<DOMElement | null>(null);
	const discoveryActionRef = useRef<DOMElement | null>(null);
	const discoveryPopupRef = useRef<DOMElement | null>(null);
	const discoveryRunRef = useRef<DOMElement | null>(null);
	const discoveryCloseRef = useRef<DOMElement | null>(null);
	const removePeerConfirmRef = useRef<DOMElement | null>(null);
	const removePeerYesRef = useRef<DOMElement | null>(null);
	const removePeerNoRef = useRef<DOMElement | null>(null);
	const sidebarRef = useRef<DOMElement | null>(null);
	const sidebarToggleRef = useRef<DOMElement | null>(null);
	const peerRefs = useRef<Array<DOMElement | null>>([]);
	const composerRef = useRef<DOMElement | null>(null);
	const commandPopupRef = useRef<DOMElement | null>(null);
	const settingsRowRefs = useRef<Array<DOMElement | null>>([]);
	const settingsTabRefs = useRef<Array<DOMElement | null>>([]);
	const settingsTabsBarRef = useRef<DOMElement | null>(null);
	const contextActionRefs = useRef<Array<DOMElement | null>>([]);
	const chatRef = useRef<DOMElement | null>(null);
	const messageRefs = useRef(new Map<string, DOMElement>());
	const acceptFileRef = useRef<DOMElement | null>(null);
	const rejectFileRef = useRef<DOMElement | null>(null);
	const copyRefs = useRef(new Map<string, DOMElement>());
	const codeCopyRefs = useRef(new Map<string, DOMElement>());
	const codeCopyValues = useRef(new Map<string, string>());
	const viewerRef = useRef<DOMElement | null>(null);
	const viewerImageRef = useRef<DOMElement | null>(null);
	const viewerOpenRef = useRef<DOMElement | null>(null);
	const viewerLocationRef = useRef<DOMElement | null>(null);
	const kittyImageId = useRef(0);
	const imagePreviewRefs = useRef(new Map<string, DOMElement>());
	const kittyPreviewIds = useRef(new Map<string, number>());
	const kittyPreviewPlacements = useRef(new Map<string, string>());
	const imageBytesCache = useRef(new Map<string, Buffer>());
	const nextKittyPreviewId = useRef(0x505100);
	const smoothScrollTimer = useRef<NodeJS.Timeout | undefined>(undefined);

	const palette = palettes[settings.theme];
	const terminalWidth = Math.max(40, columns ?? 80);
	const terminalHeight = Math.max(12, rows ?? 24);
	const sidebarVisible = settings.showSidebar && terminalWidth >= settings.sidebarBreakpoint;
	const sidebarWidth = sidebarVisible ? (sidebarCollapsed ? 10 : 28) : 0;
	const chatWidth = Math.max(20, terminalWidth - 7 - sidebarWidth);
	const chatHeight = Math.max(6, terminalHeight - 13);
	const sortedPeers = peers;
	const selected = (selectedPeerId ? sortedPeers.find(peer => peer.peerId === selectedPeerId) : undefined) ?? sortedPeers[selectedIndex];
	const conversation = useMemo(() => selected ? messages.filter(message => message.peerId === selected.peerId) : [], [messages, selected?.peerId]);
	const selectedMessageCount = selected ? Math.max(messageCounts[selected.peerId] ?? 0, conversation.length) : 0;
	const peerForOffer = pendingOffer ? peers.find(peer => peer.peerId === pendingOffer.peerId) : undefined;
	const commandSuggestions = useMemo(() => {
		if (!composer.startsWith('/') || composer.includes(' ')) return [];
		const query = composer.toLowerCase();
		return commandCatalog.filter(item => item.command.startsWith(query));
	}, [composer]);
	const activeSettingRows = settingRowsByTab[settingsTab];
	const contextItems = useMemo<ContextItem[]>(() => {
		if (!contextMenu) return [];
		const target = contextMenu.target;
		if (target.kind === 'message') {
			const message = messages.find(candidate => candidate.id === target.messageId);
			return [
				...(message?.filePath ? [{label: 'Open file', hint: 'viewer', action: 'open-file' as const}, {label: 'Reveal location', hint: 'folder', action: 'reveal-file' as const}] : []),
				...(message?.fullBody ? [{label: 'Copy message', hint: 'clipboard', action: 'copy-message' as const}] : []),
				{label: 'Focus composer', hint: 'Enter', action: 'focus-composer'}
			];
		}
		if (target.kind === 'peer') {
			const peer = sortedPeers.find(candidate => candidate.peerId === target.peerId);
			return [
				{label: peer?.status === 'connected' ? 'Reconnect' : 'Connect', hint: 'c', action: 'connect-peer'},
				{label: peer?.trusted ? 'Revoke trust' : 'Trust peer', hint: peer?.trusted ? 'revoke' : 'trust', action: peer?.trusted ? 'revoke-peer' : 'trust-peer'},
				{label: 'Remove peer', hint: 'hide', action: 'remove-peer'},
				{label: 'Focus composer', hint: 'Enter', action: 'focus-composer'}
			];
		}
		if (target.kind === 'composer') return [
			{label: 'Clear draft', hint: 'Esc', action: 'clear-draft'},
			{label: 'Open settings', hint: ',', action: 'open-settings'}
		];
		return [
			{label: 'Focus composer', hint: 'Enter', action: 'focus-composer'},
			{label: 'Clear draft', hint: 'Esc', action: 'clear-draft'},
			{label: 'Open settings', hint: ',', action: 'open-settings'}
		];
	}, [contextMenu, messages, sortedPeers]);

	useEffect(() => {
		if (!isRawModeSupported || !stdin.isTTY || !stdout.isTTY) return;
		const onData = (chunk: Buffer | string): void => {
			const value = chunk.toString();
			if (value.includes('\u0008') || value.includes('\u0017') || /\u001b\[(?:8|127);(?:5|7)(?::\d+)?u/.test(value)) {
				wordDeletePending.current = true;
				if (wordDeleteTimer.current) clearTimeout(wordDeleteTimer.current);
				wordDeleteTimer.current = setTimeout(() => { wordDeletePending.current = false; }, 250);
			}
			if (!value.includes('\u001b[<') && !mouseBuffer.current.includes('\u001b[<')) return;
			mouseBuffer.current += value;
			const pattern = /\u001b\[<(\d+);(\d+);(\d+)([mM])/;
			while (true) {
				const match = pattern.exec(mouseBuffer.current);
				if (!match) break;
				mouseBuffer.current = mouseBuffer.current.slice(match.index + match[0].length);
				const button = Number(match[1]);
				const x = Number(match[2]);
				const y = Number(match[3]);
				mouseEscapePending.current = true;
				if (match[4] === 'M') dispatchMouse(x, y, button);
			}
			if (mouseBuffer.current.length > 128) mouseBuffer.current = mouseBuffer.current.slice(-64);
		};
		stdin.prependListener('data', onData);
		stdout.write('\u001b[?1000h\u001b[?1006h\u001b[?2004h');
		return () => {
			stdin.off('data', onData);
			if (wordDeleteTimer.current) clearTimeout(wordDeleteTimer.current);
			stdout.write('\u001b[?1000l\u001b[?1006l\u001b[?2004l');
		};
	}, [isRawModeSupported, stdin, stdout]);

	useEffect(() => {
		if (sortedPeers.length === 0) {
			if (selectedPeerId !== undefined) setSelectedPeerId(undefined);
			if (selectedIndex !== 0) setSelectedIndex(0);
			return;
		}
		const currentIndex = selectedPeerId ? sortedPeers.findIndex(peer => peer.peerId === selectedPeerId) : -1;
		if (currentIndex >= 0) {
			if (selectedIndex !== currentIndex) setSelectedIndex(currentIndex);
			return;
		}
		const fallbackIndex = Math.max(0, Math.min(selectedIndex, sortedPeers.length - 1));
		const fallback = sortedPeers[fallbackIndex];
		if (selectedIndex !== fallbackIndex) setSelectedIndex(fallbackIndex);
		if (fallback && selectedPeerId !== fallback.peerId) setSelectedPeerId(fallback.peerId);
	}, [selectedIndex, selectedPeerId, sortedPeers]);

	useEffect(() => {
		setSettingsIndex(current => Math.min(current, Math.max(0, activeSettingRows.length - 1)));
	}, [activeSettingRows.length, settingsTab]);

	useEffect(() => {
		if (!sidebarVisible && focus === 'sidebar') setFocus('composer');
	}, [focus, sidebarVisible]);

	useEffect(() => {
		const connectable = peers.filter(peer => peer.status === 'discovered' && !connectingPeerIds.current.has(peer.peerId));
		if (connectable.length === 0) return;
		const timer = setTimeout(() => {
			for (const peer of connectable) void connectPeer(peer);
		}, 300);
		return () => clearTimeout(timer);
	}, [peers]);

	useEffect(() => {
		setContextMenuIndex(current => Math.min(current, Math.max(0, contextItems.length - 1)));
	}, [contextItems.length]);

	useEffect(() => {
		// Previous TUI sessions may have left Kitty graphics on the terminal
		// screen. They are an independent terminal layer, so Ink backgrounds
		// cannot paint over them; clear them before rendering this session.
		clearKittyImages(stdout);
		return () => clearKittyImages(stdout);
	}, [stdout]);

	useEffect(() => {
		if (!nativeImageTerminal()) return;
		const timer = setTimeout(() => {
			renderKittyBackdrop(stdout, palette.background, terminalHeight);
		}, 0);
		return () => {
			clearTimeout(timer);
			clearKittyImageById(stdout, KITTY_BACKDROP_IMAGE_ID);
		};
	}, [palette.background, stdout, terminalHeight, terminalWidth]);

	useEffect(() => {
		clearKittyImage(stdout, kittyImageId);
		if (!fileViewer || fileViewer.kind !== 'image' || fileViewer.loading || fileViewer.error || !nativeImageTerminal()) return;
		let cancelled = false;
		const timer = setTimeout(() => {
			const area = measureRef(viewerImageRef);
			if (area.width < 4 || area.height < 4) return;
			void readImageForTerminal(fileViewer.path).then(bytes => {
				if (cancelled) return;
				renderKittyImage(stdout, kittyImageId, bytes, area);
			}).catch(error => {
				if (!cancelled) setFileViewer(current => current?.path === fileViewer.path ? {...current, error: 'Could not read image: ' + (error as Error).message} : current);
			});
		}, 40);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			clearKittyImage(stdout, kittyImageId);
		};
	}, [fileViewer, stdout]);

	useEffect(() => {
		const previewsBlocked = !settings.imagePreviews || fileViewer || pendingOffer || discoveryOpen || removePeerConfirm || contextMenu || !nativeImageTerminal();
		if (previewsBlocked) {
			for (const imageId of kittyPreviewIds.current.values()) clearKittyImageById(stdout, imageId);
			kittyPreviewIds.current.clear();
			kittyPreviewPlacements.current.clear();
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			const visibleImages = conversation.filter(message => message.filePath && isImageFile(message.fileName ?? message.filePath, message.fileMime) && imagePreviewRefs.current.has(message.id));
			const visibleIds = new Set(visibleImages.map(message => message.id));
			for (const [messageId, imageId] of kittyPreviewIds.current) {
				if (visibleIds.has(messageId)) continue;
				clearKittyImageById(stdout, imageId);
				kittyPreviewIds.current.delete(messageId);
				kittyPreviewPlacements.current.delete(messageId);
			}
			for (const message of visibleImages) {
				const area = measureRef(imagePreviewRefs.current.get(message.id) ?? null);
				if (!message.filePath || area.width < 4 || area.height < 3) continue;
				const placement = `${message.filePath}:${area.x}:${area.y}:${area.width}:${area.height}`;
				if (kittyPreviewPlacements.current.get(message.id) === placement && kittyPreviewIds.current.has(message.id)) continue;
				const previousImageId = kittyPreviewIds.current.get(message.id);
				if (previousImageId !== undefined) clearKittyImageById(stdout, previousImageId);
				const imageId = nextKittyPreviewId.current++;
				kittyPreviewIds.current.set(message.id, imageId);
				kittyPreviewPlacements.current.set(message.id, placement);
				const cached = imageBytesCache.current.get(message.filePath);
				if (cached) {
					renderKittyImageAtId(stdout, imageId, cached, area);
					continue;
				}
				void readImageForTerminal(message.filePath).then(bytes => {
					imageBytesCache.current.set(message.filePath as string, bytes);
					if (!cancelled && kittyPreviewIds.current.get(message.id) === imageId && kittyPreviewPlacements.current.get(message.id) === placement) renderKittyImageAtId(stdout, imageId, bytes, area);
				}).catch(() => undefined);
			}
		}, 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [chatScroll, contextMenu, conversation, discoveryOpen, fileViewer, pendingOffer, removePeerConfirm, settings.imagePreviews, stdout, terminalHeight, terminalWidth]);

	useEffect(() => () => {
		if (smoothScrollTimer.current) clearInterval(smoothScrollTimer.current);
	}, []);

	useEffect(() => {
		chatScrollRef.current = chatScroll;
	}, [chatScroll]);

	useEffect(() => {
		const unresolved = conversation.filter(message => message.filePath && isImageFile(message.fileName ?? message.filePath, message.fileMime) && (!message.fileImageWidth || !message.fileImageHeight));
		if (unresolved.length === 0) return;
		let cancelled = false;
		for (const message of unresolved) {
			void readImageForTerminal(message.filePath as string).then(bytes => {
				const dimensions = pngDimensions(bytes);
				if (cancelled || !dimensions) return;
				setMessages(current => current.map(candidate => candidate.id === message.id ? {...candidate, fileImageWidth: dimensions.width, fileImageHeight: dimensions.height} : candidate));
			}).catch(() => undefined);
		}
		return () => { cancelled = true; };
	}, [conversation]);

	useEffect(() => {
		const onEvent = (event: NetworkEvent): void => {
			if (event.type === 'peer') {
				if (removedPeerIds.current.has(event.peer.peerId)) return;
				setPeers(current => {
					const next = new Map(current.map(peer => [peer.peerId, peer]));
					next.set(event.peer.peerId, {...event.peer, trusted: settings.autoTrustSeen || event.peer.trusted});
					return [...next.values()];
				});
				return;
			}
			if (event.type === 'peer-status') {
				setPeers(current => current.map(peer => peer.peerId === event.peerId ? {...peer, status: event.status} : peer));
				return;
			}
			if (event.type === 'message') {
				const message = makeMessage(event.peerId, event.direction, event.body);
				setMessages(current => appendMessage(current, message, settings.maxMessages));
				setMessageCounts(current => ({...current, [event.peerId]: (current[event.peerId] ?? 0) + 1}));
				setChatScroll(0);
				setStatus(event.direction === 'incoming' ? 'New message from ' + peerName(peers, event.peerId) : 'Message delivered');
				if (event.direction === 'incoming' && settings.notifySound) stdout.write('\u0007');
				return;
			}
			if (event.type === 'file-offer') {
				setPendingOffer({peerId: event.peerId, offer: event.offer});
				setStatus(peerName(peers, event.peerId) + ' sent ' + event.offer.name);
				return;
			}
			if (event.type === 'file-received') {
				appendFileMessage(event.peerId, event.path, event.name, event.size, event.mime, 'received');
				setStatus('Saved ' + event.name);
				return;
			}
			if (event.type === 'file-sent') {
				appendFileMessage(event.peerId, event.path, event.name, event.size, event.mime, 'sent');
				setStatus('Sent ' + event.name);
				return;
			}
			setStatus(event.message);
		};
		network.on('event', onEvent);
		return () => { network.off('event', onEvent); };
	}, [network, peers, settings.autoTrustSeen, settings.maxMessages, settings.notifySound, stdout]);

	useEffect(() => {
		const timer = setTimeout(() => {
			void saveState(directory, identity, peers, messages, settings).catch(error => setStatus('Could not save state: ' + (error as Error).message));
		}, 250);
		return () => clearTimeout(timer);
	}, [directory, identity, peers, messages, settings]);

	mouseHandler.current = handleMouseClick;

	function dispatchMouse(x: number, y: number, button: number): void {
		const key = `${x};${y};${button}`;
		const now = Date.now();
		const previous = handledMouse.current.get(key);
		if (previous && now - previous < 100) return;
		handledMouse.current.set(key, now);
		for (const [candidate, timestamp] of handledMouse.current) {
			if (now - timestamp > 500) handledMouse.current.delete(candidate);
		}
		mouseHandler.current?.(x, y, button);
	}

	useInput((input, key) => {
		const mouse = parseMouseInput(input);
		if (mouse) {
			mouseEscapePending.current = false;
			if (mouse.pressed) dispatchMouse(mouse.x, mouse.y, mouse.button);
			return;
		}
		if (key.escape && mouseEscapePending.current) {
			mouseEscapePending.current = false;
			return;
		}
		if (fileViewer) {
			if (key.escape || input.toLowerCase() === 'q') {
				closeFileViewer();
				return;
			}
			if (input.toLowerCase() === 'o') {
				openViewerFileExternally();
				return;
			}
			if (input.toLowerCase() === 'l') {
				revealViewerFile();
				return;
			}
			if (fileViewer.kind === 'text') {
				if (key.upArrow || input === 'k') moveFileViewerScroll(-1);
				else if (key.downArrow || input === 'j') moveFileViewerScroll(1);
				else if (key.pageUp) moveFileViewerScroll(-Math.max(1, terminalHeight - 10));
				else if (key.pageDown) moveFileViewerScroll(Math.max(1, terminalHeight - 10));
				else if (key.home) setFileViewer(current => current?.kind === 'text' ? {...current, scroll: 0, column: 0} : current);
				else if (key.end) setFileViewer(current => current?.kind === 'text' ? {...current, scroll: Math.max(0, (current.lines?.length ?? 1) - 1)} : current);
				else if (key.leftArrow) moveFileViewerColumn(-8);
				else if (key.rightArrow) moveFileViewerColumn(8);
			}
			return;
		}
		if (discoveryOpen) {
			if (key.escape || input.toLowerCase() === 'q') {
				setDiscoveryOpen(false);
				return;
			}
			if (input.toLowerCase() === 'r' || key.return) {
				void runDiscovery();
				return;
			}
			return;
		}
		if (removePeerConfirm) {
			if (key.escape || input.toLowerCase() === 'n') {
				setRemovePeerConfirm(undefined);
				return;
			}
			if (key.return || input.toLowerCase() === 'y') {
				removePeer(removePeerConfirm.peerId);
				return;
			}
			return;
		}
		if (contextMenu) {
			if (key.escape || input === 'q') {
				setContextMenu(undefined);
				return;
			}
			if (key.upArrow || input === 'k') {
				setContextMenuIndex(current => Math.max(0, current - 1));
				return;
			}
			if (key.downArrow || input === 'j') {
				setContextMenuIndex(current => Math.min(Math.max(0, contextItems.length - 1), current + 1));
				return;
			}
			if (key.return || input === ' ') {
				executeContextAction(contextItems[contextMenuIndex]?.action);
				return;
			}
			return;
		}
		if (key.ctrl && input === 'c') {
			void network.stop().finally(exit);
			return;
		}
		if (pendingOffer) {
			if (key.escape || input.toLowerCase() === 'r') {
				void network.rejectFile(pendingOffer.peerId, pendingOffer.offer).catch(error => setStatus('Could not reject file: ' + (error as Error).message));
				setPendingOffer(undefined);
				setStatus('File offer rejected');
				return;
			}
			if (key.return || input.toLowerCase() === 'a') {
				const offer = pendingOffer.offer;
				void network.acceptFile(pendingOffer.peerId, offer)
					.then(() => setStatus('Receiving ' + offer.name + '…'))
					.catch(error => setStatus('Could not accept file: ' + (error as Error).message));
				setPendingOffer(undefined);
				return;
			}
			return;
		}
		if (view === 'help') {
			if (key.escape || input === '?' || input.toLowerCase() === 'h') setView('chat');
			return;
		}
		if (view === 'settings') {
			handleSettingsInput(input, key);
			return;
		}
		if (key.ctrl && input.toLowerCase() === 'v') {
			void pasteFromClipboard();
			return;
		}
		if (key.ctrl && input.toLowerCase() === 'b' && focus !== 'composer') {
			if (!settings.showSidebar) {
				updateSettings({showSidebar: true});
				setSidebarCollapsed(false);
			} else {
				setSidebarCollapsed(current => !current);
			}
			return;
		}
		if (key.ctrl && input.toLowerCase() === 'd' && focus !== 'composer') {
			void runDiscovery();
			return;
		}
		if (key.tab) {
			const focusOrder: Focus[] = sidebarVisible ? ['sidebar', 'composer'] : ['composer'];
			setFocus(current => {
				const index = focusOrder.indexOf(current === 'chat' ? 'composer' : current);
				const offset = key.shift ? -1 : 1;
				return focusOrder[(index + offset + focusOrder.length) % focusOrder.length] ?? 'composer';
			});
			return;
		}
		if (focus === 'composer') {
			if (key.upArrow || key.downArrow) return;
			if (key.escape) {
				setComposer('');
				setAttachments([]);
				setComposerVersion(current => current + 1);
				setFocus(sidebarVisible ? 'sidebar' : 'composer');
				return;
			}
			if (key.return) {
				if (commandSuggestions.length > 0) return;
				const value = composer.trim();
				setComposer('');
				setAttachments([]);
				setComposerVersion(current => current + 1);
				if (value || attachments.length > 0) void submit(value, attachments);
				return;
			}
			const deleteWord = wordDeletePending.current || (key.ctrl && (key.backspace || key.delete || input === 'w' || input === 'h'));
			if (deleteWord) {
				wordDeletePending.current = false;
				if (wordDeleteTimer.current) clearTimeout(wordDeleteTimer.current);
				setComposer(current => deletePreviousWord(current));
				return;
			}
			if (key.backspace || key.delete) {
				setComposer(current => current.slice(0, -1));
				return;
			}
			if (key.leftArrow || key.rightArrow || key.home || key.end) return;
			if (key.ctrl || key.meta) return;
			if (input) {
				handlePastedOrTypedInput(input);
				return;
			}
			return;
		}
		if (key.downArrow) {
			const nextIndex = sortedPeers.length === 0 ? 0 : Math.min(selectedIndex + 1, sortedPeers.length - 1);
			selectPeerAt(nextIndex);
			return;
		}
		if (key.upArrow) {
			const nextIndex = Math.max(selectedIndex - 1, 0);
			selectPeerAt(nextIndex);
			return;
		}
		if (focus === 'sidebar' && (key.delete || (key.ctrl && input.toLowerCase() === 'x'))) {
			requestRemoveSelectedPeer();
			return;
		}
		if (key.pageUp) {
			animateChatScroll(1, 5);
			return;
		}
		if (key.pageDown) {
			animateChatScroll(-1, 5);
			return;
		}
		if (input && !key.ctrl && !key.meta) {
			setFocus('composer');
			handlePastedOrTypedInput(input);
			return;
		}
		if (key.return) setFocus('composer');
	}, {isActive: true});

	function handlePastedOrTypedInput(input: string): void {
		const pasted = unwrapBracketedPaste(input);
		if (pasted !== undefined || input.length > 1) {
			handlePastedPayload(pasted ?? input);
			return;
		}
		setComposer(current => current + input);
	}

	function handlePastedPayload(payload: string): void {
		const dataImage = decodeDataImage(payload);
		if (dataImage) {
			void stageDataImage(dataImage, directory, setAttachments, setStatus);
			setFocus('composer');
			return;
		}
		const files = attachmentsFromPayload(payload);
		if (files.length > 0) {
			setAttachments(current => mergeAttachments(current, files));
			setStatus(`${files.length} file${files.length === 1 ? '' : 's'} queued · press Enter to send`);
			setFocus('composer');
			return;
		}
		setComposer(current => current + (current && payload && !/^\s/.test(payload) ? ' ' : '') + payload);
		if (payload.includes('\n') || payload.length > 240) setStatus('Pasted text ready · full text will be sent');
	}

	async function pasteFromClipboard(): Promise<void> {
		setStatus('Reading clipboard…');
		try {
			let payload: ClipboardPayload;
			try {
				payload = await readSystemClipboard();
			} catch {
				payload = {kind: 'text', value: await readTerminalClipboard(stdin, stdout)};
			}
			if (payload.kind === 'image') await stageDataImage(payload.data, directory, setAttachments, setStatus);
			else handlePastedPayload(payload.value);
			setFocus('composer');
		} catch (error) {
			setStatus('Could not paste clipboard: ' + (error as Error).message);
		}
	}

	function appendFileMessage(peerId: PeerId, path: string, name: string, size: number, mime: string | undefined, transfer: 'sent' | 'received'): void {
		const id = String(Date.now()) + '-file-' + Math.random().toString(16).slice(2);
		const message: Message = {
			id,
			peerId,
			direction: transfer === 'received' ? 'incoming' : 'outgoing',
			body: transfer === 'received' ? `Received ${name} (${formatBytes(size)})` : `Sent ${name} (${formatBytes(size)})`,
			kind: 'file',
			filePath: path,
			fileName: name,
			...(mime ? {fileMime: mime} : {}),
			createdAt: Date.now()
		};
		setMessages(current => appendMessage(current, message, settings.maxMessages));
		setMessageCounts(current => ({...current, [peerId]: (current[peerId] ?? 0) + 1}));
		if (fileViewerKind(name, mime) === 'image') {
			void readImageForTerminal(path).then(bytes => {
				const dimensions = pngDimensions(bytes);
				if (dimensions) setMessages(current => current.map(candidate => candidate.id === id ? {...candidate, fileImageWidth: dimensions.width, fileImageHeight: dimensions.height} : candidate));
			}).catch(() => undefined);
		}
		if (size > 1024 * 1024 || fileViewerKind(name, mime) !== 'text') return;
		void readFile(path, 'utf8').then(text => {
			setMessages(current => current.map(candidate => candidate.id === id ? {...candidate, filePreview: text.slice(0, 12_000)} : candidate));
		}).catch(() => undefined);
	}

	function togglePastedMessage(messageId: string): void {
		setExpandedMessageIds(current => {
			const next = new Set(current);
			if (next.has(messageId)) next.delete(messageId);
			else next.add(messageId);
			return next;
		});
	}

	async function openFileMessage(message: Message): Promise<void> {
		if (!message.filePath) return;
		if (!existsSync(message.filePath)) {
			setStatus('File is no longer available: ' + (message.fileName ?? basename(message.filePath)));
			return;
		}
		const name = message.fileName ?? basename(message.filePath);
		const kind = fileViewerKind(name, message.fileMime);
		setContextMenu(undefined);
		if (kind === 'text') {
			setFileViewer({kind, path: message.filePath, name, ...(message.fileMime ? {mime: message.fileMime} : {}), lines: [], scroll: 0, column: 0, loading: true});
			try {
				const text = await readFile(message.filePath, 'utf8');
				setFileViewer(current => {
					if (!current || current.path !== message.filePath) return current;
					return {...current, lines: text.replace(/\r\n?/g, '\n').split('\n'), loading: false};
				});
			} catch (error) {
				setFileViewer(current => {
					if (!current || current.path !== message.filePath) return current;
					return {...current, loading: false, error: 'Could not read file: ' + (error as Error).message};
				});
			}
			return;
		}
		setFileViewer({kind, path: message.filePath, name, ...(message.fileMime ? {mime: message.fileMime} : {}), scroll: 0, column: 0});
	}

	function closeFileViewer(): void {
		setFileViewer(undefined);
	}

	function openViewerFileExternally(): void {
		if (!fileViewer) return;
		if (openPath(fileViewer.path)) setStatus('Opened ' + fileViewer.name);
		else setStatus('No file opener is available for ' + fileViewer.name);
	}

	function revealViewerFile(): void {
		if (!fileViewer) return;
		if (revealPath(fileViewer.path)) setStatus('Opened location for ' + fileViewer.name);
		else setStatus('Could not open the location for ' + fileViewer.name);
	}

	function moveFileViewerScroll(delta: number): void {
		setFileViewer(current => {
			if (!current || current.kind !== 'text') return current;
			const lineCount = current.lines?.length ?? 0;
			return {...current, scroll: Math.max(0, Math.min(Math.max(0, lineCount - 1), current.scroll + delta))};
		});
	}

	function moveFileViewerColumn(delta: number): void {
		setFileViewer(current => current?.kind === 'text' ? {...current, column: Math.max(0, current.column + delta)} : current);
	}

	function openContextMenu(mouseX: number, mouseY: number): void {
		const peerIndex = view === 'chat' ? peerRefs.current.findIndex(ref => contains(ref, mouseX, mouseY)) : -1;
		const peer = peerIndex >= 0 ? sortedPeers[peerIndex] : undefined;
		const message = view === 'chat' ? [...conversation].reverse().find(candidate => contains(messageRefs.current.get(candidate.id) ?? null, mouseX, mouseY)) : undefined;
		const target: ContextTarget = message ? {kind: 'message', messageId: message.id} : peer ? {kind: 'peer', peerId: peer.peerId} : contains(composerRef, mouseX, mouseY) ? {kind: 'composer'} : {kind: 'chat'};
		const menuWidth = Math.min(36, Math.max(24, terminalWidth - 2));
		const menuHeight = Math.min(9, Math.max(6, terminalHeight - 2));
		setContextMenu({
			x: Math.max(0, Math.min(mouseX, terminalWidth - menuWidth - 1)),
			y: Math.max(0, Math.min(mouseY, terminalHeight - menuHeight - 1)),
			target
		});
		setContextMenuIndex(0);
	}

	function executeContextAction(action: ContextAction | undefined): void {
		if (!action || !contextMenu) return;
		const target = contextMenu.target;
		if ((action === 'open-file' || action === 'reveal-file') && target.kind === 'message') {
			const message = messages.find(candidate => candidate.id === target.messageId);
			if (message?.filePath) {
				if (action === 'open-file') void openFileMessage(message);
				else if (revealPath(message.filePath)) setStatus('Opened location for ' + (message.fileName ?? basename(message.filePath)));
				else setStatus('Could not open the location for ' + (message.fileName ?? basename(message.filePath)));
			}
		} else if (action === 'copy-message' && target.kind === 'message') {
			const message = messages.find(candidate => candidate.id === target.messageId);
			if (message) copyMessage(message);
		} else if (action === 'connect-peer' && target.kind === 'peer') {
			const peer = sortedPeers.find(candidate => candidate.peerId === target.peerId);
			if (peer) {
				selectPeerAt(sortedPeers.indexOf(peer));
			}
		} else if ((action === 'trust-peer' || action === 'revoke-peer') && target.kind === 'peer') {
			const trusted = action === 'trust-peer';
			setPeers(current => current.map(peer => peer.peerId === target.peerId ? {...peer, trusted} : peer));
			setStatus(trusted ? 'Peer trusted' : 'Peer trust revoked');
		} else if (action === 'remove-peer' && target.kind === 'peer') {
			const peer = sortedPeers.find(candidate => candidate.peerId === target.peerId);
			if (peer) requestRemovePeer(peer);
		} else if (action === 'focus-composer') {
			setView('chat');
			setFocus('composer');
		} else if (action === 'clear-draft') {
			setComposer('');
			setAttachments([]);
			setComposerVersion(current => current + 1);
			setFocus('composer');
		} else if (action === 'open-settings') {
			setView('settings');
			setFocus('composer');
		}
		setContextMenu(undefined);
	}

	function requestRemoveSelectedPeer(): void {
		if (!selected) {
			setStatus('Select a peer first');
			return;
		}
		requestRemovePeer(selected);
	}

	function requestRemovePeer(peer: Peer): void {
		setContextMenu(undefined);
		setRemovePeerConfirm(peer);
	}

	function removePeer(peerId: PeerId): void {
		const peer = sortedPeers.find(candidate => candidate.peerId === peerId);
		if (!peer) {
			setRemovePeerConfirm(undefined);
			return;
		}
		removedPeerIds.current.add(peer.peerId);
		setPeers(current => current.filter(candidate => candidate.peerId !== peer.peerId));
		setSelectedPeerId(current => current === peer.peerId ? undefined : current);
		setSelectedIndex(0);
		setRemovePeerConfirm(undefined);
		setStatus('Removed ' + peer.name + ' from this session');
	}

	function handleMouseClick(x: number, y: number, button: number): void {
		// SGR mouse coordinates are 1-based; Ink layout metrics are 0-based.
		const mouseX = Math.max(0, x - 1);
		const mouseY = Math.max(0, y - 1);
		if (fileViewer) {
			if (button === 0) {
				if (contains(viewerOpenRef, mouseX, mouseY)) openViewerFileExternally();
				else if (contains(viewerLocationRef, mouseX, mouseY)) revealViewerFile();
				else if (!contains(viewerRef, mouseX, mouseY)) closeFileViewer();
			}
			return;
		}
		if (discoveryOpen) {
			if (button === 0) {
				if (contains(discoveryRunRef, mouseX, mouseY)) void runDiscovery();
				else if (contains(discoveryCloseRef, mouseX, mouseY) || !contains(discoveryPopupRef, mouseX, mouseY)) setDiscoveryOpen(false);
			}
			return;
		}
		if (removePeerConfirm) {
			if (button === 0) {
				if (contains(removePeerYesRef, mouseX, mouseY)) removePeer(removePeerConfirm.peerId);
				else if (contains(removePeerNoRef, mouseX, mouseY) || !contains(removePeerConfirmRef, mouseX, mouseY)) setRemovePeerConfirm(undefined);
			}
			return;
		}
		if (button === 2) {
			openContextMenu(mouseX, mouseY);
			return;
		}
		if (button === 64 || button === 65) {
			setContextMenu(undefined);
			const sidebar = measureRef(sidebarRef);
			if (view === 'chat' && (!sidebarVisible || mouseX >= sidebar.x + sidebar.width)) {
				if (button === 64) void scrollChatOlder(1);
				else setChatScroll(current => Math.max(0, current - 1));
			}
			return;
		}
		if (button !== 0) return;
		if (contextMenu) {
			const actionIndex = contextActionRefs.current.findIndex(ref => contains(ref, mouseX, mouseY));
			if (actionIndex >= 0) executeContextAction(contextItems[actionIndex]?.action);
			else setContextMenu(undefined);
			return;
		}
		if (pendingOffer) {
			if (contains(acceptFileRef, mouseX, mouseY)) acceptPendingFile();
			else if (contains(rejectFileRef, mouseX, mouseY)) rejectPendingFile();
			return;
		}
		if (contains(settingsActionRef, mouseX, mouseY)) { setView('settings'); setFocus('composer'); return; }
		if (contains(helpActionRef, mouseX, mouseY)) { setView('help'); return; }
		if (contains(discoveryActionRef, mouseX, mouseY)) { void runDiscovery(); return; }
		if (contains(sidebarToggleRef, mouseX, mouseY)) {
			setSidebarCollapsed(current => !current);
			setFocus('sidebar');
			return;
		}
		if (view === 'help') {
			setView('chat');
			setFocus('composer');
			return;
		}
		if (view === 'settings') {
			let tabIndex = settingsTabRefs.current.findIndex(ref => contains(ref, mouseX, mouseY));
			if (tabIndex < 0 && contains(settingsTabsBarRef, mouseX, mouseY)) {
				const tabsBar = measureRef(settingsTabsBarRef);
				const tabWidth = tabsBar.width / settingsTabs.length;
				tabIndex = Math.max(0, Math.min(settingsTabs.length - 1, Math.floor((mouseX - tabsBar.x) / Math.max(1, tabWidth))));
			}
			if (tabIndex >= 0) {
				setSettingsTab(settingsTabs[tabIndex]?.id ?? 'profile');
				setSettingsIndex(0);
				return;
			}
			const rowIndex = settingsRowRefs.current.findIndex(ref => contains(ref, mouseX, mouseY));
			const row = rowIndex >= 0 ? activeSettingRows[rowIndex] : undefined;
			if (row) {
				setSettingsIndex(rowIndex);
				if (row.id === 'name') {
					setNameDraft(identity.name);
					setEditingName(true);
				} else applySetting(row.id);
			}
			return;
		}
		if (view === 'chat') {
			const copiedCode = [...codeCopyRefs.current.entries()].find(([, ref]) => contains(ref, mouseX, mouseY));
			if (copiedCode) {
				const value = codeCopyValues.current.get(copiedCode[0]);
				if (value !== undefined) {
					copyToClipboard(value, stdout);
					setStatus('Copied code block');
				}
				return;
			}
			const copied = conversation.find(message => message.fullBody && contains(copyRefs.current.get(message.id) ?? null, mouseX, mouseY));
			if (copied) {
				copyMessage(copied);
				return;
			}
			const clickedFile = conversation.find(message => message.filePath && contains(messageRefs.current.get(message.id) ?? null, mouseX, mouseY));
			if (clickedFile) {
				void openFileMessage(clickedFile);
				return;
			}
			const pastedMessage = conversation.find(message => message.fullBody && contains(messageRefs.current.get(message.id) ?? null, mouseX, mouseY));
			if (pastedMessage) {
				togglePastedMessage(pastedMessage.id);
				return;
			}
		}
		if (focus === 'composer' && commandSuggestions.length > 0) {
			const popup = measureRef(commandPopupRef);
			const firstOptionY = popup.y + 3;
			const popupIndex = mouseY - firstOptionY;
			if (contains(commandPopupRef, mouseX, mouseY) && popupIndex >= 0 && popupIndex < Math.min(6, commandSuggestions.length)) {
				handleCommandSelect(commandSuggestions[popupIndex]?.command ?? '');
				return;
			}
		}
		if (contains(composerRef, mouseX, mouseY)) {
			setFocus('composer');
			return;
		}
		if (view === 'chat' && sidebarVisible) {
			const index = peerRefs.current.findIndex(ref => contains(ref, mouseX, mouseY));
			if (index >= 0 && index < sortedPeers.length) {
				selectPeerAt(index);
			}
			return;
		}
		if (view === 'chat') setFocus('composer');
	}

	function acceptPendingFile(): void {
		if (!pendingOffer) return;
		const offer = pendingOffer.offer;
		void network.acceptFile(pendingOffer.peerId, offer)
			.then(() => setStatus('Receiving ' + offer.name + '…'))
			.catch(error => setStatus('Could not accept file: ' + (error as Error).message));
		setPendingOffer(undefined);
	}

	function rejectPendingFile(): void {
		if (!pendingOffer) return;
		void network.rejectFile(pendingOffer.peerId, pendingOffer.offer).catch(error => setStatus('Could not reject file: ' + (error as Error).message));
		setPendingOffer(undefined);
		setStatus('File offer rejected');
	}

	function copyMessage(message: Message): void {
		const value = message.fullBody ?? message.body;
		copyToClipboard(value, stdout);
		setStatus('Copied full pasted text');
	}

	function handleCommandSelect(command: string): void {
		if (!command) return;
		setComposer(command + ' ');
		setComposerVersion(current => current + 1);
		setFocus('composer');
	}

	function handleSettingsInput(input: string, key: {downArrow?: boolean; upArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; tab?: boolean; shift?: boolean; return?: boolean; escape?: boolean; backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean}): void {
		if (editingName) {
			if (key.escape) {
				setEditingName(false);
				setNameDraft(identity.name);
				return;
			}
			if (key.return) {
				const name = nameDraft.trim().slice(0, 48);
				if (name) {
					identity.name = name;
					void saveState(directory, identity, peers, messages, settings);
					setStatus('Display name updated');
				}
				setEditingName(false);
				return;
			}
			if (key.backspace || key.delete) {
				setNameDraft(current => current.slice(0, -1));
				return;
			}
			if (!key.ctrl && !key.meta && input) setNameDraft(current => current + input);
			return;
		}
		if (key.escape || input === ',') {
			setView('chat');
			setFocus('composer');
			return;
		}
		if (key.leftArrow || (key.shift && key.tab)) {
			const index = settingsTabs.findIndex(tab => tab.id === settingsTab);
			setSettingsTab(settingsTabs[(index - 1 + settingsTabs.length) % settingsTabs.length]?.id ?? 'profile');
			setSettingsIndex(0);
			return;
		}
		if (key.rightArrow || key.tab || input === '\t') {
			const index = settingsTabs.findIndex(tab => tab.id === settingsTab);
			setSettingsTab(settingsTabs[(index + 1) % settingsTabs.length]?.id ?? 'profile');
			setSettingsIndex(0);
			return;
		}
		if (input === 'j' || key.downArrow) {
			setSettingsIndex(current => Math.min(current + 1, activeSettingRows.length - 1));
			return;
		}
		if (input === 'k' || key.upArrow) {
			setSettingsIndex(current => Math.max(current - 1, 0));
			return;
		}
		if (key.return || input === ' ') {
			const row = activeSettingRows[settingsIndex];
			if (row?.id === 'name') {
				setNameDraft(identity.name);
				setEditingName(true);
			} else if (row) {
				applySetting(row.id);
			}
		}
	}

	function updateSettings(patch: Partial<UiSettings>): void {
		setSettings(current => ({...current, ...patch}));
		if (patch.showSidebar === false && focus === 'sidebar') setFocus('composer');
	}

	function applySetting(id: SettingId): void {
		if (id === 'theme') {
			const themes: ThemeName[] = ['amber', 'ocean', 'mono'];
			const next = themes[(themes.indexOf(settings.theme) + 1) % themes.length] ?? 'amber';
			updateSettings({theme: next});
		} else if (id === 'sidebar') {
			updateSettings({showSidebar: !settings.showSidebar});
		} else if (id === 'compact') {
			updateSettings({compactMode: !settings.compactMode});
		} else if (id === 'hints') {
			updateSettings({showHints: !settings.showHints});
		} else if (id === 'notifications') {
			updateSettings({notifications: !settings.notifications});
		} else if (id === 'maxMessages') {
			updateSettings({maxMessages: settings.maxMessages >= 1000 ? 250 : settings.maxMessages + 250});
		} else if (id === 'footer') {
			updateSettings({showFooter: !settings.showFooter});
		} else if (id === 'statusFormat') {
			const formats: UiSettings['statusFormat'][] = ['name', 'name+addr', 'off'];
			updateSettings({statusFormat: formats[(formats.indexOf(settings.statusFormat) + 1) % formats.length] ?? 'name'});
		} else if (id === 'sidebarBreakpoint') {
			const values = [60, 80, 100, 120];
			updateSettings({sidebarBreakpoint: values[(values.indexOf(settings.sidebarBreakpoint) + 1) % values.length] ?? 80});
		} else if (id === 'minChatWidth') {
			const values = [30, 40, 50, 60];
			updateSettings({minChatWidth: values[(values.indexOf(settings.minChatWidth) + 1) % values.length] ?? 40});
		} else if (id === 'scrollback') {
			const values = [100, 250, 500, 1000, 5000];
			updateSettings({scrollback: values[(values.indexOf(settings.scrollback) + 1) % values.length] ?? 500});
		} else if (id === 'notifySound') {
			updateSettings({notifySound: !settings.notifySound});
		} else if (id === 'desktopNotifications') {
			updateSettings({desktopNotifications: !settings.desktopNotifications});
		} else if (id === 'imagePreviews') {
			updateSettings({imagePreviews: !settings.imagePreviews});
		} else if (id === 'autoTrustSeen') {
			updateSettings({autoTrustSeen: !settings.autoTrustSeen});
		} else if (id === 'reset') {
			updateSettings(defaultUiSettings());
			setStatus('UI settings reset to defaults');
			return;
		}
		setStatus('Setting updated');
	}

	async function scrollChatOlder(amount: number): Promise<void> {
		if (!selected || conversation.length === 0) return;
		const desired = chatScrollRef.current + amount;
		chatScrollRef.current = Math.min(desired, Math.max(0, conversation.length - 1));
		setChatScroll(Math.min(desired, Math.max(0, conversation.length - 1)));
		const total = Math.max(selectedMessageCount, conversation.length);
		if (desired < Math.max(0, conversation.length - 6) || conversation.length >= total || historyLoadingPeerId === selected.peerId) return;
		setHistoryLoadingPeerId(selected.peerId);
		try {
			const page = await loadMessagePage(directory, selected.peerId, conversation[0]?.id, MESSAGE_PAGE_SIZE);
			if (page.messages.length > 0) {
				setMessages(current => mergeMessages(current, page.messages));
				setChatScroll(Math.min(desired, Math.max(0, conversation.length + page.messages.length - 1)));
			}
			setMessageCounts(current => ({...current, [selected.peerId]: page.total}));
			setStatus(page.messages.length > 0 ? `Loaded ${page.messages.length} older messages` : 'Beginning of conversation');
		} catch (error) {
			setStatus('Could not load older messages: ' + (error as Error).message);
		} finally {
			setHistoryLoadingPeerId(current => current === selected.peerId ? undefined : current);
		}
	}

	function animateChatScroll(direction: 1 | -1, steps: number): void {
		if (smoothScrollTimer.current) clearInterval(smoothScrollTimer.current);
		let remaining = steps;
		smoothScrollTimer.current = setInterval(() => {
			setChatScroll(current => {
				const next = direction > 0
					? Math.min(current + 1, Math.max(0, conversation.length - 1))
					: Math.max(0, current - 1);
				chatScrollRef.current = next;
				return next;
			});
			remaining -= 1;
			if (remaining > 0) return;
			if (smoothScrollTimer.current) clearInterval(smoothScrollTimer.current);
			smoothScrollTimer.current = undefined;
			if (direction > 0) void scrollChatOlder(1);
		}, 35);
	}

	function selectPeerAt(index: number): void {
		const peer = sortedPeers[index];
		if (!peer) return;
		setSelectedIndex(index);
		setSelectedPeerId(peer.peerId);
		setChatScroll(0);
		setFocus('sidebar');
		if (peer.status === 'discovered') void connectPeer(peer);
	}

	async function submit(value: string, queuedAttachments: Attachment[] = attachments): Promise<void> {
		if (queuedAttachments.length > 0) {
			const sent = await sendAttachments(queuedAttachments);
			if (!sent) {
				setAttachments(queuedAttachments);
				return;
			}
		}
		if (!value) return;
		if (value.startsWith('/')) {
			const parts = value.slice(1).split(/\s+/);
			const command = parts.shift()?.toLowerCase() ?? '';
			const args = parts;
			if (command === 'help') { setView('help'); return; }
			if (command === 'settings') { setView('settings'); setFocus('composer'); return; }
			if (command === 'peers') { setStatus(sortedPeers.length + ' peer' + (sortedPeers.length === 1 ? '' : 's') + ' known'); return; }
			if (command === 'discover') { void runDiscovery(); return; }
			if (command === 'connect') {
				const target = args.join(' ').toLowerCase();
				const peer = sortedPeers.find(candidate => candidate.name.toLowerCase() === target || candidate.peerId.startsWith(target));
				if (!peer) { setStatus('Usage: /connect <peer name or id>'); return; }
				setSelectedIndex(sortedPeers.indexOf(peer));
				setSelectedPeerId(peer.peerId);
				await connectPeer(peer);
				return;
			}
			if (command === 'name') {
				const name = args.join(' ').trim().slice(0, 48);
				if (!name) { setStatus('Usage: /name <display name>'); return; }
				identity.name = name;
				setNameDraft(name);
				void saveState(directory, identity, peers, messages, settings);
				setStatus('You are now ' + name);
				return;
			}
			if (command === 'send') {
				const path = args.join(' ').trim();
				if (!selected || selected.status !== 'connected') { setStatus('Connect to a peer before sending a file'); return; }
				if (!path) { setStatus('Usage: /send <path>'); return; }
				setBusy(true);
				try {
					await network.sendFile(selected.peerId, path);
					setStatus('File delivered');
				} catch (error) {
					setStatus('Could not send file: ' + (error as Error).message);
				} finally {
					setBusy(false);
				}
				return;
			}
			if (command === 'trust' || command === 'revoke') {
				if (!selected) { setStatus('Select a peer first'); return; }
				const trusted = command === 'trust';
				setPeers(current => current.map(peer => peer.peerId === selected.peerId ? {...peer, trusted} : peer));
				setStatus(trusted ? selected.name + ' is trusted' : 'Trust revoked for ' + selected.name);
				return;
			}
			if (command === 'quit') {
				await network.stop();
				exit();
				return;
			}
			setStatus('Unknown command: /' + command + '; press ? for help');
			return;
		}
		if (!selected) {
			setStatus('Select a peer before sending a message');
			return;
		}
		if (selected.status !== 'connected') {
			setStatus(selected.name + ' is still connecting…');
			return;
		}
		try {
			await network.sendText(selected.peerId, value);
			const message = makeMessage(selected.peerId, 'outgoing', value);
			setMessages(current => appendMessage(current, message, settings.maxMessages));
			setMessageCounts(current => ({...current, [selected.peerId]: (current[selected.peerId] ?? 0) + 1}));
			setChatScroll(0);
			setStatus('Message delivered');
		} catch (error) {
			setStatus('Could not send: ' + (error as Error).message);
		}
	}

	async function sendAttachments(queued: Attachment[]): Promise<boolean> {
		if (!selected) {
			setStatus('Select a peer before sending files');
			return false;
		}
		if (selected.status !== 'connected') {
			setStatus(selected.name + ' is still connecting…');
			return false;
		}
		setBusy(true);
		try {
			for (const attachment of queued) await network.sendFile(selected.peerId, attachment.path);
			setStatus(`${queued.length} file${queued.length === 1 ? '' : 's'} delivered`);
			return true;
		} catch (error) {
			setStatus('Could not send file: ' + (error as Error).message);
			return false;
		} finally {
			setBusy(false);
		}
	}

	async function connectPeer(peer: Peer): Promise<void> {
		if (peer.status === 'connected') return;
		if (connectingPeerIds.current.has(peer.peerId)) {
			setStatus('Connecting to ' + peer.name + '…');
			return;
		}
		connectingPeerIds.current.add(peer.peerId);
		setPeers(current => current.map(candidate => candidate.peerId === peer.peerId ? {...candidate, status: 'connecting'} : candidate));
		setBusy(true);
		try {
			await network.connect(peer.peerId);
			setPeers(current => current.map(candidate => candidate.peerId === peer.peerId ? {...candidate, status: 'connected'} : candidate));
			setStatus('Connected to ' + peer.name);
		} catch (error) {
			setPeers(current => current.map(candidate => candidate.peerId === peer.peerId ? {...candidate, status: 'offline'} : candidate));
			setStatus('Could not connect: ' + (error as Error).message);
		} finally {
			connectingPeerIds.current.delete(peer.peerId);
			setBusy(connectingPeerIds.current.size > 0);
		}
	}

	async function runDiscovery(): Promise<void> {
		setDiscoveryOpen(true);
		setDiscovering(true);
		setStatus('Scanning for nearby peers…');
		try {
			const found = await network.discoverNow();
			setPeers(current => {
				const next = new Map(current.map(peer => [peer.peerId, peer]));
				for (const peer of found) {
					if (!removedPeerIds.current.has(peer.peerId)) next.set(peer.peerId, {...peer, trusted: settings.autoTrustSeen || peer.trusted});
				}
				return [...next.values()];
			});
			const visible = found.filter(peer => !removedPeerIds.current.has(peer.peerId));
			setStatus(`Discovery found ${visible.length} peer${visible.length === 1 ? '' : 's'}`);
		} catch (error) {
			setStatus('Discovery failed: ' + (error as Error).message);
		} finally {
			setDiscovering(false);
		}
	}

	return (
		<Box width={terminalWidth} height={terminalHeight} flexDirection="column" backgroundColor={palette.background} paddingX={1} paddingY={1}>
			<TopBar identity={identity} peers={sortedPeers.length} busy={busy} palette={palette} view={view} narrow={terminalWidth < 100} discoveryActionRef={discoveryActionRef} settingsActionRef={settingsActionRef} helpActionRef={helpActionRef} />
			{view === 'chat' && (
				<Box flexGrow={1} flexDirection="row" gap={1} marginTop={1}>
					{sidebarVisible && <Sidebar identity={identity} peers={sortedPeers} selectedIndex={selectedIndex} focus={focus} collapsed={sidebarCollapsed} compact={settings.compactMode || terminalWidth < 100} palette={palette} sidebarRef={sidebarRef} sidebarToggleRef={sidebarToggleRef} peerRefs={peerRefs} />}
					<Chat peer={selected} messages={conversation} totalMessages={selectedMessageCount} historyLoading={historyLoadingPeerId === selected?.peerId} scroll={chatScroll} width={chatWidth} height={chatHeight} palette={palette} compact={settings.compactMode || terminalWidth < 100} narrow={terminalWidth < 100} imagePreviews={settings.imagePreviews} expandedMessageIds={expandedMessageIds} copyRefs={copyRefs} codeCopyRefs={codeCopyRefs} codeCopyValues={codeCopyValues} messageRefs={messageRefs} imagePreviewRefs={imagePreviewRefs} chatRef={chatRef} onCopy={copyMessage} />
				</Box>
			)}
			{view === 'settings' && <SettingsView identity={identity} settings={settings} tab={settingsTab} tabs={settingsTabs} rows={activeSettingRows} selectedIndex={settingsIndex} editingName={editingName} nameDraft={nameDraft} palette={palette} rowRefs={settingsRowRefs} tabRefs={settingsTabRefs} tabBarRef={settingsTabsBarRef} />}
			{view === 'help' && <HelpView palette={palette} />}
			{view === 'chat' && <Composer key={composerVersion} peer={selected} focused={focus === 'composer'} status={status} showHints={settings.showHints} narrow={terminalWidth < 100} palette={palette} value={composer} attachments={attachments} commands={commandSuggestions} onCommandSelect={handleCommandSelect} composerRef={composerRef} commandPopupRef={commandPopupRef} />}
			{view !== 'chat' && settings.showFooter && <Footer text="Esc close  ·  Tab change focus  ·  ? help  ·  Ctrl+C quit" palette={palette} />}
			{pendingOffer && <FilePrompt from={peerForOffer?.name ?? 'peer'} offer={pendingOffer.offer} palette={palette} terminalWidth={terminalWidth} acceptRef={acceptFileRef} rejectRef={rejectFileRef} />}
			{contextMenu && <ContextMenu menu={contextMenu} items={contextItems} selectedIndex={contextMenuIndex} palette={palette} actionRefs={contextActionRefs} />}
			{discoveryOpen && <DiscoveryPopup peers={sortedPeers} discovering={discovering} palette={palette} terminalWidth={terminalWidth} popupRef={discoveryPopupRef} runRef={discoveryRunRef} closeRef={discoveryCloseRef} />}
			{removePeerConfirm && <RemovePeerConfirm peer={removePeerConfirm} palette={palette} terminalWidth={terminalWidth} popupRef={removePeerConfirmRef} yesRef={removePeerYesRef} noRef={removePeerNoRef} />}
			{fileViewer && <FileViewer viewer={fileViewer} palette={palette} terminalWidth={terminalWidth} terminalHeight={terminalHeight} viewerRef={viewerRef} imageRef={viewerImageRef} openRef={viewerOpenRef} locationRef={viewerLocationRef} />}
		</Box>
	);
}

function measureRef(ref: RefTarget): Rect {
	const node = ref && 'current' in ref ? ref.current : ref;
	return node ? measureElement(node) : {x: 0, y: 0, width: 0, height: 0};
}

function contains(ref: RefTarget, x: number, y: number): boolean {
	const rect = measureRef(ref);
	return rect.width > 0 && rect.height > 0 && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function TopBar({identity, peers, busy, palette, view, narrow, discoveryActionRef, settingsActionRef, helpActionRef}: {identity: Identity; peers: number; busy: boolean; palette: Palette; view: View; narrow: boolean; discoveryActionRef: ElementRef; settingsActionRef: ElementRef; helpActionRef: ElementRef}): React.JSX.Element {
	return <Box minHeight={3} flexShrink={0} flexDirection="row" borderStyle="round" borderColor={palette.strongBorder} paddingX={1} alignItems="center">
		<Text color={palette.accent} bold>PPX</Text>
		<Text color={palette.text} bold>{narrow ? ' MESH' : '  LOCAL MESH'}</Text>
		<Text color={palette.dim}>  /  {view.toUpperCase()}</Text>
		<Box flexGrow={1} />
		<Box paddingX={1}>
			<Text color={busy ? palette.warning : palette.success} bold>{busy ? (narrow ? '◌ WORK' : '◌ WORKING') : (narrow ? '● OK' : '● READY')}</Text>
		</Box>
		<Text color={palette.dim}>  </Text>
		<Box paddingX={1}><Text color={palette.text} bold wrap="truncate">{narrow ? identity.name.slice(0, 10) : identity.name}</Text></Box>
		<Text color={palette.dim}>  </Text>
		<Box ref={discoveryActionRef} flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[D]</Text>{!narrow && <Text color={palette.text}>iscover</Text>}</Box>
		<Text color={palette.dim}> </Text>
		<Box ref={settingsActionRef} flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[S]</Text>{!narrow && <Text color={palette.text}>ettings</Text>}</Box>
		<Text color={palette.dim}> </Text>
		<Box ref={helpActionRef} flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[?]</Text>{!narrow && <Text color={palette.text}> help</Text>}</Box>
	</Box>;
}

function messageBodyLines(message: Message, width: number, expanded = false): {lines: string[]; truncated: boolean} {
	const source = expanded && message.fullBody ? message.fullBody : message.body;
	const lines = wrapDisplayText(source, Math.max(8, message.filePath ? width - 2 : width));
	const limit = expanded && message.fullBody ? 14 : lines.length;
	return {lines: lines.slice(0, limit), truncated: lines.length > limit};
}

function messageRowHeight(message: Message, bodyLines: string[], previewLines: string[], compact: boolean, imagePreviewHeight: number, segmentRows: number, groupedWithNext: boolean): number {
	const previewHeight = previewLines.length > 0 ? previewLines.length + 3 : 0;
	const contentHeight = message.filePath ? (imagePreviewHeight > 0 ? imagePreviewHeight + 2 : bodyLines.length + previewHeight + 4) : segmentRows;
	const borderRows = groupedWithNext ? 1 : 2;
	return borderRows + 1 + contentHeight + (message.fullBody ? 3 : 0) + (compact || groupedWithNext ? 0 : 1);
}

function messageSegments(message: Message, width: number, expanded: boolean): MessageSegment[] {
	const source = expanded && message.fullBody ? message.fullBody : message.body;
	const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
	const segments: MessageSegment[] = [];
	let offset = 0;
	for (const match of source.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > offset) segments.push({kind: 'text', lines: wrapDisplayText(source.slice(offset, index).replace(/\n$/, ''), width)});
		const code = (match[2] ?? '').replace(/\n$/, '');
		const lines = code.split('\n').slice(0, 12).map(line => line.length > width - 2 ? line.slice(0, Math.max(1, width - 3)) + '…' : line);
		segments.push({kind: 'code', language: (match[1] ?? '').trim() || 'code', code, lines: lines.length > 0 ? lines : ['']});
		offset = index + match[0].length;
	}
	if (offset < source.length) segments.push({kind: 'text', lines: wrapDisplayText(source.slice(offset).replace(/^\n/, ''), width)});
	return segments.length > 0 ? segments : [{kind: 'text', lines: wrapDisplayText(source, width)}];
}

function segmentRowCount(segments: MessageSegment[]): number {
	return segments.reduce((rows, segment) => rows + segment.lines.length + (segment.kind === 'code' ? 5 : 0), 0);
}

function messagesBelongTogether(previous: Message | undefined, current: Message): boolean {
	return Boolean(previous && !previous.filePath && !current.filePath && !previous.fullBody && !current.fullBody && previous.direction !== 'system' && current.direction === previous.direction && current.createdAt - previous.createdAt <= 2 * 60 * 1000);
}

function imagePreviewRows(message: Message, width: number): number {
	if (!message.fileImageWidth || !message.fileImageHeight) return 7;
	const aspect = message.fileImageWidth / message.fileImageHeight;
	return Math.max(5, Math.min(18, Math.round(Math.max(12, width) / Math.max(0.01, aspect * 2)) + 2));
}

function filePreviewLines(message: Message, width: number): string[] {
	if (!message.filePreview) return [];
	const lines = message.filePreview.replace(/\r\n?/g, '\n').split('\n').slice(0, 6);
	return lines.map(line => line.length > width ? line.slice(0, Math.max(1, width - 1)) + '…' : line);
}

function wrapDisplayText(value: string, width: number): string[] {
	const lines: string[] = [];
	for (const sourceLine of value.replace(/\r\n?/g, '\n').split('\n')) {
		if (sourceLine.length === 0) {
			lines.push('');
			continue;
		}
		let remaining = sourceLine;
		while (remaining.length > width) {
			let cut = remaining.lastIndexOf(' ', width);
			if (cut < Math.max(1, Math.floor(width * 0.55))) cut = width;
			lines.push(remaining.slice(0, cut).trimEnd());
			remaining = remaining.slice(cut);
			if (remaining.startsWith(' ')) remaining = remaining.slice(1);
		}
		lines.push(remaining);
	}
	return lines.length > 0 ? lines : [''];
}

function Sidebar({identity, peers, selectedIndex, focus, collapsed, compact, palette, sidebarRef, sidebarToggleRef, peerRefs}: {identity: Identity; peers: Peer[]; selectedIndex: number; focus: Focus; collapsed: boolean; compact: boolean; palette: Palette; sidebarRef: ElementRef; sidebarToggleRef: ElementRef; peerRefs: React.MutableRefObject<Array<DOMElement | null>>}): React.JSX.Element {
	const width = collapsed ? 10 : 28;
	return <Box ref={sidebarRef} width={width} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={focus === 'sidebar' ? palette.accent : palette.border} paddingX={1}>
		<Box ref={sidebarToggleRef} height={1} flexDirection="row" alignItems="center">
			<Text color={palette.accent} bold>{collapsed ? `◈ ${String(peers.length).padStart(2, '0')}` : '◈ PEERS'}</Text>
			<Box flexGrow={1} />
			{!collapsed && <><Box borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.text} bold>{String(peers.length).padStart(2, '0')}</Text></Box><Text color={palette.dim}> [−]</Text></>}
		</Box>
		{collapsed ? <>
			<Box marginTop={1} flexDirection="column" alignItems="center">
				<Text color={palette.dim} bold>ME</Text>
				<Text color={palette.success}>●</Text>
			</Box>
			{peers.map((peer, index) => {
				const selected = index === selectedIndex;
				const marker = peer.status === 'connected' ? '●' : peer.status === 'connecting' ? '◌' : peer.status === 'offline' ? '×' : '○';
				return <Box ref={node => { peerRefs.current[index] = node; }} key={peer.peerId} height={3} borderStyle="round" borderColor={selected ? palette.accent : palette.border} marginTop={compact ? 0 : 1} alignItems="center" justifyContent="center">
					<Text color={selected ? palette.accent : palette.dim} bold={selected}>{selected ? '◆' : '◇'}</Text>
					<Text color={peer.status === 'connected' ? palette.success : palette.muted}> {marker}</Text>
					<Text color={selected ? palette.accent : palette.text} bold={selected}> {peer.name.slice(0, 1).toUpperCase()}</Text>
				</Box>;
			})}
			<Box flexGrow={1} />
			<Box alignItems="center" justifyContent="center"><Text color={palette.dim}>» B</Text></Box>
		</> : <>
			<Box marginTop={1} paddingX={1} flexShrink={0}>
				<Text color={palette.accent} bold>● </Text><Text color={palette.text} bold wrap="truncate">{identity.name}</Text><Text color={palette.muted}>  you</Text>
			</Box>
			{peers.length === 0 && <Box marginTop={1} borderStyle="round" borderColor={palette.border} paddingX={1} flexDirection="column"><Text color={palette.text} bold>No peers yet</Text><Text color={palette.dim}>Use [D] or /discover.</Text></Box>}
			{peers.map((peer, index) => {
				const selected = index === selectedIndex;
				const marker = peer.status === 'connected' ? '●' : peer.status === 'connecting' ? '◌' : peer.status === 'offline' ? '×' : '○';
				return <Box ref={node => { peerRefs.current[index] = node; }} key={peer.peerId} flexDirection="column" borderStyle={selected ? 'round' : undefined} borderColor={palette.accent} paddingX={1} marginTop={compact ? 0 : 1}>
					<Box flexDirection="row">
						<Text color={selected ? palette.accent : palette.text} bold={selected}>{selected ? '› ' : '  '}{marker} </Text><Text color={selected ? palette.accent : palette.text} bold={selected} wrap="truncate">{peer.name}</Text>
						<Box flexGrow={1} />
						<Text color={peer.status === 'connected' ? palette.success : palette.muted} bold>{peer.status === 'connected' ? 'ON' : 'OFF'}</Text>
					</Box>
					{!compact && <Text color={peer.status === 'connected' ? palette.success : palette.muted} wrap="truncate">{peer.trusted ? 'trusted · ' : ''}{peer.fingerprint}</Text>}
				</Box>;
			})}
			<Box flexGrow={1} />
			<Box paddingX={1}><Text color={palette.dim} wrap="truncate">Ctrl+B collapse · ↑↓ select</Text></Box>
		</>}
	</Box>;
}

function Chat({peer, messages, totalMessages, historyLoading, scroll, width, height, palette, compact, narrow, imagePreviews, expandedMessageIds, copyRefs, codeCopyRefs, codeCopyValues, messageRefs, imagePreviewRefs, chatRef, onCopy}: {peer: Peer | undefined; messages: Message[]; totalMessages: number; historyLoading: boolean; scroll: number; width: number; height: number; palette: Palette; compact: boolean; narrow: boolean; imagePreviews: boolean; expandedMessageIds: Set<string>; copyRefs: React.MutableRefObject<Map<string, DOMElement>>; codeCopyRefs: React.MutableRefObject<Map<string, DOMElement>>; codeCopyValues: React.MutableRefObject<Map<string, string>>; messageRefs: React.MutableRefObject<Map<string, DOMElement>>; imagePreviewRefs: React.MutableRefObject<Map<string, DOMElement>>; chatRef: ElementRef; onCopy: (message: Message) => void}): React.JSX.Element {
	const bodyWidth = Math.max(12, width - 12);
	const viewportHeight = Math.max(3, height - 7);
	const layouts = messages.map((message, index) => {
		const expanded = expandedMessageIds.has(message.id);
		const body = messageBodyLines(message, bodyWidth, expanded);
		const segments = message.filePath ? [] : messageSegments(message, Math.max(10, Math.floor(bodyWidth * 0.78) - 4), expanded);
		const previewLines = filePreviewLines(message, Math.max(12, bodyWidth - 4));
		const imagePreview = imagePreviews && Boolean(message.filePath && isImageFile(message.fileName ?? message.filePath, message.fileMime));
		const imagePreviewHeight = imagePreview ? imagePreviewRows(message, Math.floor(bodyWidth * 0.78) - 4) : 0;
		const groupedWithPrevious = messagesBelongTogether(messages[index - 1], message);
		const nextMessage = messages[index + 1];
		const groupedWithNext = Boolean(nextMessage && messagesBelongTogether(message, nextMessage));
		return {message, bodyLines: body.lines, bodyTruncated: body.truncated, segments, previewLines, imagePreviewHeight, expanded, groupedWithPrevious, groupedWithNext, height: messageRowHeight(message, body.lines, previewLines, compact, imagePreviewHeight, segmentRowCount(segments), groupedWithNext)};
	});
	const end = Math.max(0, messages.length - Math.min(scroll, messages.length));
	let start = end;
	let used = 0;
	while (start > 0) {
		const nextHeight = layouts[start - 1]?.height ?? 1;
		if (used + nextHeight > viewportHeight && start < end) break;
		used += nextHeight;
		start -= 1;
	}
	const visible = layouts.slice(start, end);
	const persistedTotal = Math.max(totalMessages, messages.length);
	const unloadedCount = Math.max(0, persistedTotal - messages.length);
	const globalStart = unloadedCount + start;
	const globalEnd = unloadedCount + end;
	return <Box ref={chatRef} flexGrow={1} flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1} overflow="hidden">
		<Box minHeight={2} flexShrink={0} flexDirection="row" borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor={palette.border} paddingX={1} alignItems="center">
			<Text color={peer ? palette.success : palette.dim} bold>{peer ? '●' : '○'} </Text>
			<Box flexDirection="column" width={narrow ? 16 : 24}>
				<Text color={palette.accent} bold>{peer?.name ?? 'Conversation'}</Text>
				<Text color={palette.muted}>{peer ? statusLabel(peer) : 'Select a peer from the sidebar'}</Text>
			</Box>
			<Box flexGrow={1} />
			{!narrow && <Box paddingX={1}><Text color={palette.dim} wrap="truncate">{peer?.fingerprint ?? 'private · local only'}</Text></Box>}
			<Text color={palette.dim}>  {persistedTotal} msg</Text>
		</Box>
		<Box flexGrow={1} flexDirection="row" overflow="hidden">
			<Box flexGrow={1} flexDirection="column" paddingTop={1} overflow="hidden">
				{!peer && <EmptyState title="Your private inbox" body="Select a peer to start an encrypted conversation." palette={palette} />}
				{peer && messages.length === 0 && <EmptyState title={`Start a conversation with ${peer.name}`} body="Just type—your message goes straight into the composer. Press Enter to send." palette={palette} />}
				{visible.map(layout => <MessageRow key={layout.message.id} message={layout.message} bodyLines={layout.bodyLines} bodyTruncated={layout.bodyTruncated} segments={layout.segments} previewLines={layout.previewLines} imagePreviewHeight={layout.imagePreviewHeight} expanded={layout.expanded} groupedWithPrevious={layout.groupedWithPrevious} groupedWithNext={layout.groupedWithNext} peer={peer} palette={palette} compact={compact} copyRefs={copyRefs} codeCopyRefs={codeCopyRefs} codeCopyValues={codeCopyValues} messageRefs={messageRefs} imagePreviewRefs={imagePreviewRefs} onCopy={onCopy} />)}
			</Box>
			{messages.length > 0 && <ChatScrollbar total={persistedTotal} start={globalStart} end={globalEnd} height={viewportHeight} palette={palette} />}
		</Box>
		<Box flexDirection="row" borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor={palette.border} paddingX={1} alignItems="center"><Text color={historyLoading ? palette.warning : palette.dim}>{historyLoading ? '◌ loading older messages…' : scroll > 0 ? `↑ ${globalStart + 1}–${globalEnd} of ${persistedTotal}` : '● live'}</Text><Box flexGrow={1} /><Text color={palette.dim}>PgUp/PgDn · wheel</Text></Box>
	</Box>;
}

function ChatScrollbar({total, start, end, height, palette}: {total: number; start: number; end: number; height: number; palette: Palette}): React.JSX.Element {
	const trackHeight = Math.max(1, height - 1);
	const visibleCount = Math.max(1, end - start);
	const thumbHeight = Math.max(1, Math.min(trackHeight, Math.round(trackHeight * visibleCount / Math.max(1, total))));
	const travel = Math.max(0, trackHeight - thumbHeight);
	const top = total <= visibleCount ? 0 : Math.round(travel * start / Math.max(1, total - visibleCount));
	return <Box width={2} height={height} flexShrink={0} flexDirection="column" alignItems="center" paddingTop={1}>
		{Array.from({length: trackHeight}, (_, index) => <Text key={index} color={index >= top && index < top + thumbHeight ? palette.accent : palette.border}>{index >= top && index < top + thumbHeight ? '█' : '│'}</Text>)}
	</Box>;
}

function MessageRow({message, bodyLines, bodyTruncated, segments, previewLines, imagePreviewHeight, expanded, groupedWithPrevious, groupedWithNext, peer, palette, compact, copyRefs, codeCopyRefs, codeCopyValues, messageRefs, imagePreviewRefs, onCopy}: {message: Message; bodyLines: string[]; bodyTruncated: boolean; segments: MessageSegment[]; previewLines: string[]; imagePreviewHeight: number; expanded: boolean; groupedWithPrevious: boolean; groupedWithNext: boolean; peer: Peer | undefined; palette: Palette; compact: boolean; copyRefs: React.MutableRefObject<Map<string, DOMElement>>; codeCopyRefs: React.MutableRefObject<Map<string, DOMElement>>; codeCopyValues: React.MutableRefObject<Map<string, string>>; messageRefs: React.MutableRefObject<Map<string, DOMElement>>; imagePreviewRefs: React.MutableRefObject<Map<string, DOMElement>>; onCopy: (message: Message) => void}): React.JSX.Element {
	const system = message.direction === 'system';
	const outgoing = message.direction === 'outgoing';
	const file = Boolean(message.filePath);
	const markdown = isMarkdownFile(message.fileName ?? message.filePath ?? '');
	const label = system ? 'system' : message.direction === 'incoming' ? peer?.name ?? 'peer' : 'you';
	const borderColor = system ? palette.warning : message.direction === 'incoming' ? palette.success : palette.accent;
	return <Box ref={node => { if (node) messageRefs.current.set(message.id, node); else messageRefs.current.delete(message.id); }} width={system ? '100%' : '78%'} alignSelf={system ? 'center' : outgoing ? 'flex-end' : 'flex-start'} flexDirection="column" borderStyle="round" borderBottom={!groupedWithNext} borderColor={borderColor} paddingX={1} marginBottom={compact || groupedWithNext ? 0 : 1}>
		{groupedWithPrevious ? <Box flexDirection="row">
			<Text color={palette.border}>·</Text><Box flexGrow={1} /><Text color={palette.dim}>{formatTime(message.createdAt)}</Text>
		</Box> : <Box flexDirection="row">
			<Box flexGrow={1} flexShrink={1}><Text color={borderColor} bold wrap="truncate">{message.direction === 'incoming' ? '← ' : message.direction === 'outgoing' ? '→ ' : '· '}{label}</Text></Box>
			<Text color={palette.dim} wrap="truncate">{formatTime(message.createdAt)}</Text>
			{message.fullBody && <Text color={palette.accent} bold>  [{expanded ? '− COLLAPSE' : '+ EXPAND'}]</Text>}
			{message.fullBody && <Box marginLeft={1} ref={node => { if (node) copyRefs.current.set(message.id, node); else copyRefs.current.delete(message.id); }} borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[COPY]</Text></Box>}
		</Box>}
		{file ? <Box flexDirection="column" borderStyle={imagePreviewHeight > 0 ? undefined : 'round'} borderColor={palette.border} paddingX={1}>
			<Box flexDirection="row"><Text color={palette.accent} bold>{fileTypeLabel(message.fileName ?? message.filePath ?? '')}</Text><Text color={palette.text} bold wrap="truncate">  {message.fileName ?? basename(message.filePath ?? '')}</Text><Box flexGrow={1} /><Text color={palette.success} bold>[OPEN]</Text></Box>
			{imagePreviewHeight === 0 && bodyLines.map((line, index) => <Text key={`${message.id}-file-${index}`} color={palette.muted} wrap="truncate">{line || ' '}</Text>)}
			{imagePreviewHeight > 0 && <Box ref={node => { if (node) imagePreviewRefs.current.set(message.id, node); else imagePreviewRefs.current.delete(message.id); }} height={imagePreviewHeight} alignItems="center" justifyContent="center">
				<Text color={palette.dim}>{nativeImageTerminal() ? ' ' : '▧ image preview · open for full size'}</Text>
			</Box>}
			{previewLines.length > 0 && <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor={palette.border} paddingX={1}>
				<Text color={markdown ? palette.accent : palette.muted} bold>{markdown ? 'MARKDOWN PREVIEW' : 'TEXT PREVIEW'}</Text>
				{previewLines.map((line, index) => <Text key={`${message.id}-preview-${index}`} color={markdown ? markdownLineColor(line, palette) : palette.text} wrap="truncate">{line || ' '}</Text>)}
			</Box>}
			<Text color={palette.dim}>{imagePreviewHeight > 0 ? 'click to view · o open · l reveal' : 'click anywhere to view · o open externally · l reveal location'}</Text>
		</Box> : <Box flexDirection="column">{segments.map((segment, segmentIndex) => segment.kind === 'text'
			? <Box key={`${message.id}-text-${segmentIndex}`} flexDirection="column">{segment.lines.map((line, lineIndex) => <Text key={lineIndex} color={system ? palette.muted : palette.text} wrap="truncate">{line || ' '}</Text>)}</Box>
			: <CodeBlock key={`${message.id}-code-${segmentIndex}`} id={`${message.id}:${segmentIndex}`} segment={segment} palette={palette} codeCopyRefs={codeCopyRefs} codeCopyValues={codeCopyValues} />)}</Box>}
		{message.fullBody && <Text color={palette.dim}>{expanded ? (bodyTruncated ? 'expanded preview · more text available · click to collapse' : 'expanded · click to collapse') : 'pasted text collapsed · click to expand'} · [COPY] keeps the full original</Text>}
	</Box>;
}

function CodeBlock({id, segment, palette, codeCopyRefs, codeCopyValues}: {id: string; segment: Extract<MessageSegment, {kind: 'code'}>; palette: Palette; codeCopyRefs: React.MutableRefObject<Map<string, DOMElement>>; codeCopyValues: React.MutableRefObject<Map<string, string>>}): React.JSX.Element {
	codeCopyValues.current.set(id, segment.code);
	return <Box flexDirection="column" borderStyle="single" borderColor={palette.strongBorder} paddingX={1}>
		<Box flexDirection="row"><Text color={palette.warning} bold>{segment.language.toUpperCase()}</Text><Box flexGrow={1} /><Box ref={node => { if (node) codeCopyRefs.current.set(id, node); else { codeCopyRefs.current.delete(id); codeCopyValues.current.delete(id); } }} borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[COPY CODE]</Text></Box></Box>
		{segment.lines.map((line, index) => <Text key={index} color={palette.text} wrap="truncate"><Text color={palette.dim}>{String(index + 1).padStart(2, ' ')} </Text>{line || ' '}</Text>)}
	</Box>;
}

function Composer({peer, focused, status, showHints, narrow, palette, value, attachments, commands, onCommandSelect, composerRef, commandPopupRef}: {peer: Peer | undefined; focused: boolean; status: string; showHints: boolean; narrow: boolean; palette: Palette; value: string; attachments: Attachment[]; commands: CommandItem[]; onCommandSelect: (command: string) => void; composerRef: ElementRef; commandPopupRef: ElementRef}): React.JSX.Element {
	const hasContent = Boolean(value || attachments.length > 0);
	const placeholder = peer ? 'message, Ctrl+V, drop a file, or /command' : 'select a peer or type /help';
	return <Box ref={composerRef} minHeight={3} flexShrink={0} flexDirection="column" borderStyle="round" borderColor={focused ? palette.accent : palette.strongBorder} paddingX={1} marginTop={1}>
		<Box height={1} flexDirection="row" alignItems="center">
			<Text color={focused ? palette.accent : palette.dim} bold>{focused ? 'COMPOSE' : 'MESSAGE'}</Text>
			<Text color={palette.muted}> / </Text>
			<Text color={attachments.length > 0 ? palette.warning : (focused ? palette.accent : palette.muted)}>{attachments.length > 0 ? '[file] ' + attachmentPreview(attachments) + ' › ' : (peer ? peer.name + ' › ' : 'ppx › ')}</Text>
			<Box flexGrow={1}>
				{hasContent ? <Text color={focused ? palette.text : palette.muted} wrap="truncate">{inlineComposerPreview(value)}</Text> : <Text color={palette.dim} dimColor italic wrap="truncate">{placeholder}</Text>}
			</Box>
			{focused && hasContent && <Text color={palette.accent}>▌</Text>}
			{!hasContent && <Text color={status.startsWith('Could not') ? palette.error : palette.muted} wrap="truncate">  {status}</Text>}
			{showHints && !narrow && <Text color={focused ? palette.accent : palette.dim}>  {hasContent ? 'Enter send' : 'Enter'}</Text>}
		</Box>
		{focused && commands.length > 0 && <CommandPopup commands={commands} palette={palette} onSelect={onCommandSelect} popupRef={commandPopupRef} />}
	</Box>;
}

function CommandPopup({commands, palette, onSelect, popupRef}: {commands: CommandItem[]; palette: Palette; onSelect: (command: string) => void; popupRef: ElementRef}): React.JSX.Element {
	return <Box ref={popupRef} flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} paddingY={1} marginTop={1}>
		<Box flexDirection="row"><Text color={palette.accent} bold>COMMANDS</Text><Box flexGrow={1} /><Text color={palette.dim}>↑↓ choose · Enter/click fill</Text></Box>
		<Select
			options={commands.map(item => ({label: item.command + '  ' + item.description, value: item.command}))}
			visibleOptionCount={Math.min(6, commands.length)}
			onChange={onSelect}
		/>
	</Box>;
}

function ContextMenu({menu, items, selectedIndex, palette, actionRefs}: {menu: ContextMenuState; items: ContextItem[]; selectedIndex: number; palette: Palette; actionRefs: React.MutableRefObject<Array<DOMElement | null>>}): React.JSX.Element {
	const title = menu.target.kind === 'peer' ? 'PEER ACTIONS' : menu.target.kind === 'message' ? 'MESSAGE ACTIONS' : 'CHAT ACTIONS';
	return <Box position="absolute" marginLeft={menu.x} marginTop={menu.y} width={36} flexDirection="column" borderStyle="round" borderColor={palette.strongBorder} backgroundColor={palette.overlay} paddingX={1} paddingY={1}>
		<Box flexDirection="row"><Text color={palette.accent} bold>{title}</Text><Box flexGrow={1} /><Text color={palette.dim}>right click</Text></Box>
		{items.map((item, index) => {
			const selected = index === selectedIndex;
			return <Box key={item.action} ref={node => { actionRefs.current[index] = node; }} flexDirection="row" borderStyle="round" borderColor={selected ? palette.accent : palette.border} backgroundColor={palette.overlay} paddingX={1}>
				<Text color={selected ? palette.accent : palette.text} bold={selected}>{selected ? '› ' : '  '}{item.label}</Text>
				<Box flexGrow={1} />
				<Text color={selected ? palette.text : palette.muted}>{item.hint}</Text>
			</Box>;
		})}
		<Text color={palette.dim}>↑↓ move · Enter choose · Esc close</Text>
	</Box>;
}

function DiscoveryPopup({peers, discovering, palette, terminalWidth, popupRef, runRef, closeRef}: {peers: Peer[]; discovering: boolean; palette: Palette; terminalWidth: number; popupRef: ElementRef; runRef: ElementRef; closeRef: ElementRef}): React.JSX.Element {
	const width = Math.max(44, Math.min(68, terminalWidth - 4));
	return <Box ref={popupRef} position="absolute" marginLeft={Math.max(1, Math.floor((terminalWidth - width) / 2))} marginTop={4} width={width} flexDirection="column" borderStyle="round" borderColor={palette.accent} backgroundColor={palette.overlay} paddingX={2} paddingY={1}>
		<Box flexDirection="row"><Text color={palette.accent} bold>DISCOVERY</Text><Box flexGrow={1} /><Text color={discovering ? palette.warning : palette.success} bold>{discovering ? 'SCANNING…' : `${peers.length} FOUND`}</Text></Box>
		<Text color={palette.dim}>LAN multicast + same-machine registry</Text>
		<Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={palette.border} backgroundColor={palette.overlay} paddingX={1}>
			{peers.length === 0 ? <Text color={palette.muted}>No peers discovered yet. Start both terminals, then scan again.</Text> : peers.map(peer => <Box key={peer.peerId} flexDirection="row"><Text color={peer.status === 'connected' ? palette.success : palette.accent} bold>{peer.status === 'connected' ? '●' : '○'} </Text><Text color={palette.text} bold>{peer.name}</Text><Text color={palette.muted}>  {peer.status}</Text><Box flexGrow={1} /><Text color={palette.dim}>{peer.fingerprint.slice(0, 12)} · {formatTime(peer.lastSeen)}</Text></Box>)}
		</Box>
		<Box marginTop={1} flexDirection="row" alignItems="center">
			<Box ref={runRef} borderStyle="round" borderColor={palette.accent} paddingX={1}><Text color={palette.accent} bold>[R] SCAN NOW</Text></Box>
			<Box flexGrow={1} />
			<Box ref={closeRef} borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.text}>[Esc] CLOSE</Text></Box>
		</Box>
	</Box>;
}

function RemovePeerConfirm({peer, palette, terminalWidth, popupRef, yesRef, noRef}: {peer: Peer; palette: Palette; terminalWidth: number; popupRef: ElementRef; yesRef: ElementRef; noRef: ElementRef}): React.JSX.Element {
	const width = Math.max(42, Math.min(58, terminalWidth - 4));
	return <Box ref={popupRef} position="absolute" marginLeft={Math.max(1, Math.floor((terminalWidth - width) / 2))} marginTop={6} width={width} flexDirection="column" borderStyle="round" borderColor={palette.warning} backgroundColor={palette.overlay} paddingX={2} paddingY={1}>
		<Box flexDirection="row"><Text color={palette.warning} bold>REMOVE PEER</Text><Box flexGrow={1} /><Text color={palette.dim}>confirmation</Text></Box>
		<Text color={palette.text} wrap="wrap">Remove {peer.name} from this session?</Text>
		<Text color={palette.muted} wrap="wrap">This hides the peer until the next manual discovery or restart.</Text>
		<Box marginTop={1} flexDirection="row">
			<Box ref={yesRef} borderStyle="round" borderColor={palette.warning} backgroundColor={palette.overlay} paddingX={1}><Text color={palette.warning} bold>[Y] REMOVE</Text></Box>
			<Box marginLeft={1} ref={noRef} borderStyle="round" borderColor={palette.border} backgroundColor={palette.overlay} paddingX={1}><Text color={palette.text}>[N] CANCEL</Text></Box>
			<Box flexGrow={1} />
			<Text color={palette.dim}>Enter confirm · Esc cancel</Text>
		</Box>
	</Box>;
}

function FileViewer({viewer, palette, terminalWidth, terminalHeight, viewerRef, imageRef, openRef, locationRef}: {viewer: FileViewerState; palette: Palette; terminalWidth: number; terminalHeight: number; viewerRef: ElementRef; imageRef: ElementRef; openRef: ElementRef; locationRef: ElementRef}): React.JSX.Element {
	const width = Math.max(30, Math.min(112, terminalWidth - 4));
	const height = Math.max(10, Math.min(terminalHeight - 2, 42));
	const visibleLines = Math.max(3, height - 9);
	const visibleColumns = Math.max(12, width - 10);
	const lines = viewer.lines ?? [];
	const shownLines = lines.slice(viewer.scroll, viewer.scroll + visibleLines).map(line => line.slice(viewer.column, viewer.column + visibleColumns));
	const title = viewer.kind === 'image' ? 'IMAGE VIEWER' : viewer.kind === 'text' ? 'TEXT VIEWER' : 'FILE';
	return <Box ref={viewerRef} position="absolute" marginLeft={Math.max(1, Math.floor((terminalWidth - width) / 2))} marginTop={1} width={width} height={height} flexDirection="column" borderStyle="round" borderColor={palette.accent} backgroundColor={palette.overlay} paddingX={1} paddingY={1}>
		<Box flexDirection="row" flexShrink={0}><Text color={palette.accent} bold>{title}</Text><Text color={palette.text} bold>  {viewer.name}</Text><Box flexGrow={1} /><Text color={palette.dim}>{viewer.mime ?? fileTypeLabel(viewer.name)}</Text></Box>
		<Box flexDirection="row" flexShrink={0}><Text color={palette.dim} wrap="truncate">{viewer.path}</Text></Box>
		{viewer.kind === 'image' ? <Box ref={imageRef} flexGrow={1} minHeight={4} marginTop={1} borderStyle="round" borderColor={palette.border} backgroundColor={palette.overlay} alignItems="center" justifyContent="center">
			{viewer.error ? <Text color={palette.error} wrap="wrap">{viewer.error}</Text> : <Text color={palette.dim}>{nativeImageTerminal() ? 'Rendering the original image…' : 'This terminal may not support native images; press o for the original.'}</Text>}
		</Box> : viewer.kind === 'text' ? <Box flexGrow={1} minHeight={3} marginTop={1} borderStyle="round" borderColor={palette.border} backgroundColor={palette.overlay} paddingX={1} flexDirection="column">
			{viewer.loading ? <Text color={palette.dim}>Reading full file…</Text> : viewer.error ? <Text color={palette.error} wrap="wrap">{viewer.error}</Text> : shownLines.map((line, index) => <Text key={`${viewer.scroll}-${viewer.column}-${index}`} color={markdownLineColor(line, palette)} wrap="truncate"><Text color={palette.dim}>{String(viewer.scroll + index + 1).padStart(4, ' ')} │ </Text>{line || ' '}</Text>)}
		</Box> : <Box flexGrow={1} minHeight={3} marginTop={1} borderStyle="round" borderColor={palette.border} backgroundColor={palette.overlay} paddingX={2} paddingY={1} flexDirection="column">
			<Text color={palette.accent} bold>FILE READY</Text>
			<Text color={palette.text} wrap="wrap">Open the original file with your system viewer, or reveal its containing folder.</Text>
		</Box>}
		<Box flexDirection="row" flexShrink={0} marginTop={1} alignItems="center"><Box ref={openRef} flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[O] OPEN ORIGINAL</Text></Box><Text color={palette.dim}>  </Text><Box ref={locationRef} flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1}><Text color={palette.accent} bold>[L] REVEAL LOCATION</Text></Box><Box flexGrow={1} /><Text color={palette.dim}>Esc close{viewer.kind === 'text' ? ' · ↑↓/PgUp/PgDn scroll · ←→ line' : ''}</Text></Box>
	</Box>;
}

function SettingsView({identity, settings, tab, tabs, rows, selectedIndex, editingName, nameDraft, palette, rowRefs, tabRefs, tabBarRef}: {identity: Identity; settings: UiSettings; tab: SettingTab; tabs: Array<{id: SettingTab; label: string}>; rows: SettingRow[]; selectedIndex: number; editingName: boolean; nameDraft: string; palette: Palette; rowRefs: React.MutableRefObject<Array<DOMElement | null>>; tabRefs: React.MutableRefObject<Array<DOMElement | null>>; tabBarRef: ElementRef}): React.JSX.Element {
	let previousSection = '';
	return <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={palette.strongBorder} paddingX={2} paddingY={1} marginTop={1}>
		<Box height={2} flexDirection="row" alignItems="center"><Text color={palette.accent} bold>SETTINGS</Text><Text color={palette.muted}>  /  {tabs.find(entry => entry.id === tab)?.label.toUpperCase()}</Text><Box flexGrow={1} /><Text color={palette.dim}>preferences stay local</Text></Box>
		<Box ref={tabBarRef} flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1} height={3}>
			{tabs.map((entry, index) => <Box key={entry.id} ref={node => { tabRefs.current[index] = node; }} flexDirection="row" borderStyle="round" borderColor={entry.id === tab ? palette.accent : palette.border} paddingX={1}><Text color={entry.id === tab ? palette.accent : palette.muted} bold={entry.id === tab}>{entry.id === tab ? '› ' : '  '}{entry.label}</Text></Box>)}
		</Box>
		{tab === 'about' ? <AboutSettings palette={palette} /> : <Box marginTop={1} flexDirection="column" width={78}>
			{rows.map((row, index) => {
				const section = row.section !== previousSection ? row.section : '';
				previousSection = row.section;
				const selected = index === selectedIndex;
				const value = settingValue(row.id, settings, editingName ? nameDraft : identity.name);
				return <React.Fragment key={row.id}>
					{section && <Text color={palette.warning} bold>{section.toUpperCase()}</Text>}
					<Box ref={node => { rowRefs.current[index] = node; }} flexDirection="row" borderStyle="round" borderColor={selected ? palette.accent : palette.border} paddingX={1}>
						<Text color={selected ? palette.accent : palette.text}>{selected ? '› ' : '  '}{row.label}</Text>
						<Box flexGrow={1} />
						<Text color={selected ? palette.text : palette.muted} bold={selected}>{value}{selected && row.id === 'name' && editingName ? '▌' : ''}</Text>
					</Box>
				</React.Fragment>;
			})}
		</Box>}
		<Box flexGrow={1} />
		<Box height={2} flexDirection="row" alignItems="center"><Text color={palette.dim}>←/→ or Tab tabs · j/k move · Enter/Space change · Esc close</Text></Box>
	</Box>;
}

function AboutSettings({palette}: {palette: Palette}): React.JSX.Element {
	return <Box marginTop={1} borderStyle="round" borderColor={palette.border} paddingX={2} paddingY={1} flexDirection="column" alignSelf="stretch">
		<Text color={palette.accent} bold>LOCAL MESH CLIENT</Text>
		<Text color={palette.text}>Encrypted X25519 sessions · ChaCha20-Poly1305 payloads</Text>
		<Text color={palette.muted}>Discovery uses LAN multicast with a same-machine fallback for local testing.</Text>
		<Text color={palette.dim}>Tab through settings · changes persist automatically</Text>
	</Box>;
}

function HelpView({palette}: {palette: Palette}): React.JSX.Element {
	return <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={palette.strongBorder} paddingX={2} paddingY={1} marginTop={1}>
		<Box borderStyle="round" borderColor={palette.accent} paddingX={2} paddingY={1} flexDirection="column">
			<Text color={palette.accent} bold>HELP & COMMANDS</Text>
			<Text color={palette.muted}>PPX keeps discovery, handshakes, messages, and files on your LAN.</Text>
		</Box>
		<Box marginTop={1} borderStyle="round" borderColor={palette.border} paddingX={2} paddingY={1} flexDirection="column">
			<HelpLine keyName="Tab" text="switch between peers and chat input" palette={palette} />
			<HelpLine keyName="↑ / ↓" text="move through peers" palette={palette} />
			<HelpLine keyName="Enter" text="focus composer, send, or activate setting" palette={palette} />
			<HelpLine keyName="Ctrl+V" text="paste clipboard text, pictures, or files" palette={palette} />
			<HelpLine keyName="Drop" text="drag files into the terminal to attach them" palette={palette} />
			<HelpLine keyName="Del / Ctrl+X" text="remove selected peer (confirm)" palette={palette} />
			<HelpLine keyName="Ctrl+B" text="collapse or expand the sidebar" palette={palette} />
			<HelpLine keyName="," text="open settings" palette={palette} />
			<HelpLine keyName="PgUp/PgDn" text="scroll the current conversation" palette={palette} />
			<HelpLine keyName="Esc" text="close a view or clear the composer" palette={palette} />
		</Box>
		<Box marginTop={1} borderStyle="round" borderColor={palette.border} paddingX={2} paddingY={1} flexDirection="column">
			<Text color={palette.warning} bold>COMMANDS</Text>
			<Text color={palette.text}>/connect NAME · /peers · /discover · /name NAME</Text>
			<Text color={palette.text}>/send PATH · /trust · /revoke · /settings · /quit</Text>
		</Box>
		<Box flexGrow={1} />
		<Text color={palette.dim}>Press ? or Esc to return</Text>
	</Box>;
}

function HelpLine({keyName, text, palette}: {keyName: string; text: string; palette: Palette}): React.JSX.Element {
	return <Box flexDirection="row"><Text color={palette.accent} bold>{keyName.padEnd(11)}</Text><Text color={palette.text}>{text}</Text></Box>;
}

function EmptyState({title, body, palette}: {title: string; body: string; palette: Palette}): React.JSX.Element {
	return <Box flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center" paddingX={2}>
		<Text color={palette.accent} bold>◇  {title}</Text>
		<Text color={palette.muted} wrap="wrap">{body}</Text>
	</Box>;
}

function FilePrompt({from, offer, palette, terminalWidth, acceptRef, rejectRef}: {from: string; offer: FileOffer; palette: Palette; terminalWidth: number; acceptRef: ElementRef; rejectRef: ElementRef}): React.JSX.Element {
	const width = Math.max(38, Math.min(64, terminalWidth - 4));
	return <Box position="absolute" marginTop={6} marginLeft={Math.max(1, Math.floor((terminalWidth - width) / 2))} width={width} flexDirection="column" borderStyle="round" borderColor={palette.warning} backgroundColor={palette.overlay} paddingX={2} paddingY={1}>
		<Text color={palette.warning} bold>INCOMING FILE</Text>
		<Text color={palette.text}>{from} wants to send {offer.name}</Text>
		<Text color={palette.muted}>{formatBytes(offer.size)}{offer.mime ? ' · ' + offer.mime : ''}</Text>
		<Box marginTop={1} flexDirection="row" backgroundColor={palette.overlay}><Box ref={acceptRef} backgroundColor={palette.overlay}><Text color={palette.success} bold>[ ACCEPT ]</Text></Box><Text color={palette.dim}>   </Text><Box ref={rejectRef} backgroundColor={palette.overlay}><Text color={palette.error} bold>[ REJECT ]</Text></Box></Box>
		<Text color={palette.accent}>Enter / a accept · r / Esc reject</Text>
	</Box>;
}

function Footer({text, palette}: {text: string; palette: Palette}): React.JSX.Element {
	return <Box flexDirection="row" borderStyle="round" borderColor={palette.border} paddingX={1} alignItems="center"><Text color={palette.dim}>{text}</Text></Box>;
}

function appendMessage(messages: Message[], message: Message, maxMessages: number): Message[] {
	return [...messages, message].slice(-Math.max(2, maxMessages));
}

function mergeMessages(current: Message[], older: Message[]): Message[] {
	const merged = new Map(current.map(message => [message.id, message]));
	for (const message of older) merged.set(message.id, message);
	return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function statusLabel(peer: Peer): string {
	return peer.status + (peer.trusted ? ' · trusted' : '');
}

function onOff(value: boolean): string {
	return value ? 'on' : 'off';
}

function settingValue(id: SettingId, settings: UiSettings, name: string): string {
	switch (id) {
		case 'name': return name;
		case 'theme': return settings.theme;
		case 'sidebar': return onOff(settings.showSidebar);
		case 'compact': return onOff(settings.compactMode);
		case 'hints': return onOff(settings.showHints);
		case 'footer': return onOff(settings.showFooter);
		case 'statusFormat': return settings.statusFormat;
		case 'sidebarBreakpoint': return `${settings.sidebarBreakpoint} columns`;
		case 'minChatWidth': return `${settings.minChatWidth} columns`;
		case 'scrollback': return `${settings.scrollback} messages`;
		case 'notifications': return onOff(settings.notifications);
		case 'notifySound': return onOff(settings.notifySound);
		case 'desktopNotifications': return onOff(settings.desktopNotifications);
		case 'imagePreviews': return onOff(settings.imagePreviews);
		case 'autoTrustSeen': return onOff(settings.autoTrustSeen);
		case 'maxMessages': return `${settings.maxMessages} messages`;
		case 'reset': return 'restore defaults';
	}
}

function peerName(peers: Peer[], id: PeerId): string {
	return peers.find(peer => peer.peerId === id)?.name ?? 'peer';
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
	return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

function parseMouseInput(input: string): {x: number; y: number; button: number; pressed: boolean} | undefined {
	const match = input.match(/(?:\u001b)?\[<(\d+);(\d+);(\d+)([mM])$/);
	if (!match) return undefined;
	return {button: Number(match[1]), x: Number(match[2]), y: Number(match[3]), pressed: match[4] === 'M'};
}

function unwrapBracketedPaste(input: string): string | undefined {
	const startMarker = input.includes('\u001b[200~') ? '\u001b[200~' : '[200~';
	const endMarker = input.includes('\u001b[201~') ? '\u001b[201~' : '[201~';
	const start = input.indexOf(startMarker);
	if (start < 0) return undefined;
	const contentStart = start + startMarker.length;
	const end = input.indexOf(endMarker, contentStart);
	return (end < 0 ? input.slice(contentStart) : input.slice(contentStart, end)).replace(/\r\n/g, '\n');
}

function attachmentsFromPayload(payload: string): Attachment[] {
	const trimmed = payload
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && line !== 'copy' && line !== 'cut' && !line.startsWith('#'))
		.join('\n')
		.trim();
	if (!trimmed) return [];
	const whole = fileCandidate(trimmed);
	if (whole) return [whole];
	const tokens = [...trimmed.matchAll(/file:\/\/[^\s]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+/g)].map(match => match[0]);
	if (tokens.length === 0) return [];
	const files = tokens.map(fileCandidate);
	if (files.some(file => !file)) return [];
	return mergeAttachments([], files.filter((file): file is Attachment => Boolean(file)));
}

async function readSystemClipboard(): Promise<ClipboardPayload> {
	if (process.platform === 'linux') {
		if (process.env.WAYLAND_DISPLAY) try {
			const types = (await captureCommand('wl-paste', ['--list-types'], 64 * 1024)).toString('utf8').split(/\r?\n/).filter(Boolean);
			const uriType = ['text/uri-list', 'x-special/gnome-copied-files'].find(type => types.includes(type));
			if (uriType) {
				const value = (await captureCommand('wl-paste', ['--no-newline', '--type', uriType], 8 * 1024 * 1024)).toString('utf8');
				if (value) return {kind: 'text', value};
			}
			const imageType = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].find(type => types.includes(type));
			if (imageType) {
				const bytes = await captureCommand('wl-paste', ['--no-newline', '--type', imageType], 32 * 1024 * 1024);
				const extension = imageType === 'image/jpeg' ? 'jpg' : imageType.slice('image/'.length);
				return {kind: 'image', data: {mime: imageType, extension, bytes}};
			}
			const value = (await captureCommand('wl-paste', ['--no-newline'], 8 * 1024 * 1024)).toString('utf8');
			if (value) return {kind: 'text', value};
		} catch {
			// Continue through native desktop fallbacks below.
		}
		try {
			const payload = await captureCommand('python3', ['-c', QT_CLIPBOARD_READER], 32 * 1024 * 1024);
			const separator = payload.indexOf(10);
			if (separator > 0) {
				const kind = payload.subarray(0, separator).toString('ascii');
				const content = payload.subarray(separator + 1);
				if (kind === 'PNG' && content.length > 0) return {kind: 'image', data: {mime: 'image/png', extension: 'png', bytes: content}};
				if ((kind === 'URI' || kind === 'TXT') && content.length > 0) return {kind: 'text', value: content.toString('utf8')};
			}
		} catch {
			// KDE's Klipper DBus API is the final Linux text/URI fallback.
		}
		for (const command of ['qdbus6', 'qdbus']) {
			try {
				const value = (await captureCommand(command, ['org.kde.klipper', '/klipper', 'org.kde.klipper.klipper.getClipboardContents'], 8 * 1024 * 1024)).toString('utf8').replace(/\n$/, '');
				if (value) return {kind: 'text', value};
			} catch {
				continue;
			}
		}
		throw new Error('clipboard has no text or file path; raw image paste requires wl-clipboard');
	}
	if (process.platform === 'darwin') {
		const value = (await captureCommand('pbpaste', [], 8 * 1024 * 1024)).toString('utf8');
		if (value) return {kind: 'text', value};
	}
	if (process.platform === 'win32') {
		const output = (await captureCommand('powershell.exe', powershellArgs(WINDOWS_CLIPBOARD_READER), 48 * 1024 * 1024)).toString('utf8').replace(/^\uFEFF/, '');
		const separator = output.indexOf('\n');
		const kind = separator < 0 ? '' : output.slice(0, separator).trim();
		const content = separator < 0 ? '' : output.slice(separator + 1);
		if (kind === 'PNG' && content.trim()) return {kind: 'image', data: {mime: 'image/png', extension: 'png', bytes: Buffer.from(content.trim(), 'base64')}};
		if (kind === 'URI' && content.trim()) return {kind: 'text', value: content.replace(/\r\n/g, '\n').trimEnd()};
		if (kind === 'TXT' && content) return {kind: 'text', value: content.replace(/\r\n/g, '\n')};
	}
	throw new Error('clipboard is empty or unavailable');
}

function readTerminalClipboard(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<string> {
	if (!stdin.isTTY || !stdout.isTTY) return Promise.reject(new Error('terminal clipboard is unavailable'));
	return new Promise((resolve, reject) => {
		const suspendedListeners = stdin.listeners('data');
		for (const listener of suspendedListeners) stdin.removeListener('data', listener as (chunk: Buffer | string) => void);
		let response = '';
		let settled = false;
		const restore = (): void => {
			stdin.removeListener('data', onData);
			for (const listener of suspendedListeners) stdin.on('data', listener as (chunk: Buffer | string) => void);
		};
		const finish = (error?: Error, value?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			restore();
			if (error) reject(error);
			else resolve(value ?? '');
		};
		const onData = (chunk: Buffer | string): void => {
			response += chunk.toString();
			const match = response.match(/\u001b\]52;(?:c)?;([A-Za-z0-9+/=]*)?(?:\u0007|\u001b\\)/);
			if (!match) {
				if (response.length > 12 * 1024 * 1024) finish(new Error('terminal clipboard response is too large'));
				return;
			}
			try {
				const value = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
				if (!value) finish(new Error('clipboard is empty'));
				else finish(undefined, value);
			} catch (error) {
				finish(error as Error);
			}
		};
		const timer = setTimeout(() => finish(new Error('terminal did not return clipboard data; allow clipboard-read in Ghostty')), 1500);
		stdin.on('data', onData);
		stdout.write('\u001b]52;c;?\u001b\\');
	});
}

const QT_CLIPBOARD_READER = `
import sys
try:
    from PyQt6.QtGui import QGuiApplication
    from PyQt6.QtCore import QBuffer, QIODevice
    write_only = QIODevice.OpenModeFlag.WriteOnly
except ImportError:
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtCore import QBuffer, QIODevice
    write_only = QIODevice.OpenModeFlag.WriteOnly
app = QGuiApplication.instance() or QGuiApplication([])
clipboard = app.clipboard()
mime = clipboard.mimeData()
if mime.hasUrls():
    data = "\\n".join(url.toString() for url in mime.urls()).encode("utf-8")
    sys.stdout.buffer.write(b"URI\\n" + data)
elif mime.hasImage():
    image = clipboard.image()
    buffer = QBuffer()
    buffer.open(write_only)
    image.save(buffer, "PNG")
    sys.stdout.buffer.write(b"PNG\\n" + bytes(buffer.data()))
elif mime.hasText():
    sys.stdout.buffer.write(b"TXT\\n" + mime.text().encode("utf-8"))
`;

const WINDOWS_CLIPBOARD_READER = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    [Console]::Out.Write("URI\`n" + (([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }) -join "\`n"))
} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $stream = [System.IO.MemoryStream]::new()
    try {
        [System.Windows.Forms.Clipboard]::GetImage().Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        [Console]::Out.Write("PNG\`n" + [Convert]::ToBase64String($stream.ToArray()))
    } finally {
        $stream.Dispose()
    }
} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
    [Console]::Out.Write("TXT\`n" + [System.Windows.Forms.Clipboard]::GetText())
}
`;

function powershellArgs(script: string): string[] {
	return ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function captureCommand(command: string, args: string[], maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
		const chunks: Buffer[] = [];
		let size = 0;
		let errorOutput = '';
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		child.stdout?.on('data', chunk => {
			const bytes = Buffer.from(chunk);
			size += bytes.length;
			if (size > maxBytes) {
				child.kill();
				fail(new Error('clipboard content is too large'));
				return;
			}
			chunks.push(bytes);
		});
		child.stderr?.on('data', chunk => { errorOutput += Buffer.from(chunk).toString('utf8'); });
		child.once('error', error => fail(error as Error));
		child.once('close', code => {
			if (settled) return;
			settled = true;
			if (code === 0) resolve(Buffer.concat(chunks));
			else reject(new Error(errorOutput.trim() || `${command} exited with code ${code}`));
		});
	});
}

function decodeDataImage(payload: string): DataImage | undefined {
	const match = payload.trim().match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/);
	if (!match) return undefined;
	const mime = match[1]!;
	const encoded = match[2]!.replace(/\s/g, '');
	if (encoded.length > 32 * 1024 * 1024) return undefined;
	const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
	return {mime, extension, bytes: Buffer.from(encoded, 'base64')};
}

async function stageDataImage(data: DataImage, directory: string, setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>, setStatus: React.Dispatch<React.SetStateAction<string>>): Promise<void> {
	try {
		const targetDirectory = join(directory, 'pasted');
		await mkdir(targetDirectory, {recursive: true, mode: 0o700});
		const name = `pasted-image-${Date.now()}.${data.extension}`;
		const path = join(targetDirectory, name);
		await writeFile(path, data.bytes, {mode: 0o600});
		setAttachments(current => mergeAttachments(current, [{path, name}]));
		setStatus('Pasted image queued · press Enter to send');
	} catch (error) {
		setStatus('Could not stage pasted image: ' + (error as Error).message);
	}
}

function fileCandidate(raw: string): Attachment | undefined {
	let value = raw.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
	try {
		value = value.startsWith('file://') ? fileURLToPath(value) : value;
	} catch {
		return undefined;
	}
	value = value.replaceAll('\\ ', ' ');
	if (value === '~' || value.startsWith('~/')) value = homedir() + value.slice(1);
	const path = resolve(value);
	try {
		if (!existsSync(path) || !statSync(path).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return {path, name: basename(path)};
}

function mergeAttachments(current: Attachment[], next: Attachment[]): Attachment[] {
	const merged = new Map(current.map(file => [file.path, file]));
	for (const file of next) merged.set(file.path, file);
	return [...merged.values()];
}

function deletePreviousWord(value: string): string {
	return value.replace(/\s+$/, '').replace(/\S+$/, '');
}

function inlineComposerPreview(value: string): string {
	const flat = value.replace(/\r?\n/g, ' ↵ ').replace(/\t/g, '  ');
	return flat.length > 116 ? flat.slice(0, 100) + `… (${value.length} chars)` : flat;
}

function attachmentPreview(files: Attachment[]): string {
	const names = files.map(file => file.name).join(', ');
	return names.length > 28 ? names.slice(0, 24) + `… +${files.length - 1}` : names;
}

function makeMessage(peerId: PeerId, direction: 'incoming' | 'outgoing', body: string): Message {
	const pasted = body.includes('\n') || body.length > 240;
	return {
		id: String(Date.now()) + '-' + Math.random().toString(16).slice(2),
		peerId,
		direction,
		body: pasted ? shortenPastedText(body) : body,
		...(pasted ? {fullBody: body, kind: 'pasted-text' as const} : {kind: 'text' as const}),
		createdAt: Date.now()
	};
}

function shortenPastedText(value: string): string {
	const flat = value.replace(/\r?\n/g, ' ↵ ').replace(/\t/g, '  ').replace(/ {2,}/g, ' ').trim();
	return flat.length > 220 ? flat.slice(0, 190) + `… (${value.length} chars pasted)` : flat;
}

function fileViewerKind(name: string, mime?: string): FileViewerState['kind'] {
	const extension = extname(name).toLowerCase();
	if (mime?.startsWith('text/') || ['.txt', '.md', '.markdown', '.mdown', '.mkd', '.log', '.csv', '.json', '.yaml', '.yml', '.toml', '.ini', '.conf'].includes(extension)) return 'text';
	if (mime?.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'].includes(extension)) return 'image';
	return 'file';
}

function isImageFile(name: string, mime?: string): boolean {
	return fileViewerKind(name, mime) === 'image';
}

function isMarkdownFile(name: string): boolean {
	return ['.md', '.markdown', '.mdown', '.mkd'].includes(extname(name).toLowerCase());
}

function openPath(path: string): boolean {
	if (process.platform === 'darwin') return launchDetached('open', [path]);
	if (process.platform === 'win32') return launchDetached('explorer.exe', [path]);
	return launchDetached('xdg-open', [path]);
}

function revealPath(path: string): boolean {
	if (process.platform === 'darwin') return launchDetached('open', ['-R', path]);
	if (process.platform === 'win32') return launchDetached('explorer.exe', ['/select,' + path]);
	return openPath(dirname(path));
}

function launchDetached(command: string, args: string[]): boolean {
	try {
		const child = spawn(command, args, {detached: true, stdio: 'ignore'});
		child.once('error', () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function fileTypeLabel(name: string): string {
	const extension = extname(name).slice(1).toUpperCase();
	if (!extension) return '[FILE]';
	return `[${extension.slice(0, 5)}]`;
}

function markdownLineColor(line: string, palette: Palette): string {
	if (/^\s*#{1,6}\s/.test(line)) return palette.accent;
	if (/^\s*(```|~~~)/.test(line)) return palette.warning;
	if (/^\s*>/.test(line)) return palette.success;
	return palette.text;
}

function nativeImageTerminal(): boolean {
	const term = (process.env.TERM ?? '').toLowerCase();
	const program = (process.env.TERM_PROGRAM ?? '').toLowerCase();
	return Boolean(process.env.KITTY_WINDOW_ID || process.env.WEZTERM_PANE || term.includes('ghostty') || program.includes('ghostty') || program.includes('kitty') || program.includes('wezterm'));
}

async function readImageForTerminal(path: string): Promise<Buffer> {
	if (extname(path).toLowerCase() === '.png') return readFile(path);
	let lastError: Error | undefined;
	for (const command of ['magick', 'convert']) {
		try {
			return await convertImageToPng(command, path);
		} catch (error) {
			lastError = error as Error;
		}
	}
	throw lastError ?? new Error('Could not convert image to PNG');
}

function convertImageToPng(command: string, path: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [path, 'png:-'], {stdio: ['ignore', 'pipe', 'pipe']});
		const chunks: Buffer[] = [];
		let errorOutput = '';
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		child.stdout?.on('data', chunk => chunks.push(Buffer.from(chunk)));
		child.stderr?.on('data', chunk => { errorOutput += Buffer.from(chunk).toString('utf8'); });
		child.once('error', error => fail(new Error(`${command} is unavailable: ${(error as Error).message}`)));
		child.once('close', code => {
			if (settled) return;
			settled = true;
			if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
			else reject(new Error(`${command} could not decode the image${errorOutput.trim() ? ': ' + errorOutput.trim() : ''}`));
		});
	});
}

function clearKittyImage(stdout: NodeJS.WriteStream, imageIdRef: React.MutableRefObject<number>): void {
	if (!imageIdRef.current) return;
	clearKittyImageById(stdout, imageIdRef.current);
	imageIdRef.current = 0;
}

function clearKittyImageById(stdout: NodeJS.WriteStream, imageId: number): void {
	stdout.write(`\u001b_Ga=d,d=I,i=${imageId},q=2\u001b\\`);
}

function clearKittyImages(stdout: NodeJS.WriteStream): void {
	stdout.write('\u001b_Ga=d,d=A,q=2\u001b\\');
}

function renderKittyBackdrop(stdout: NodeJS.WriteStream, color: string, rows: number): void {
	clearKittyImageById(stdout, KITTY_BACKDROP_IMAGE_ID);
	const [red, green, blue] = parseHexColor(color);
	const strip = Buffer.alloc(8 * 3);
	for (let offset = 0; offset < strip.length; offset += 3) {
		strip[offset] = red;
		strip[offset + 1] = green;
		strip[offset + 2] = blue;
	}
	const encoded = strip.toString('base64');
	const height = Math.max(1, rows);
	stdout.write(`\u001b7\u001b[1;1H\u001b_Ga=T,f=24,s=8,v=1,i=${KITTY_BACKDROP_IMAGE_ID},r=${height},C=1,z=${KITTY_BACKDROP_Z_INDEX},q=2;${encoded}\u001b\\\u001b8`);
}

function parseHexColor(color: string): [number, number, number] {
	const value = color.startsWith('#') ? color.slice(1) : color;
	if (!/^[0-9a-f]{6}$/i.test(value)) return [16, 23, 26];
	return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function renderKittyImage(stdout: NodeJS.WriteStream, imageIdRef: React.MutableRefObject<number>, bytes: Buffer, area: Rect): void {
	clearKittyImage(stdout, imageIdRef);
	const imageId = ++imageIdRef.current;
	renderKittyImageAtId(stdout, imageId, bytes, area);
}

function renderKittyImageAtId(stdout: NodeJS.WriteStream, imageId: number, bytes: Buffer, area: Rect): void {
	const encoded = bytes.toString('base64');
	const availableColumns = Math.max(1, area.width - 4);
	const availableRows = Math.max(1, area.height - 3);
	const dimensions = pngDimensions(bytes);
	const imageAspect = dimensions ? dimensions.width / dimensions.height : undefined;
	let rows = availableRows;
	let columns = imageAspect ? Math.max(1, Math.round(imageAspect * rows * 2)) : availableColumns;
	let sizeParameter: string;
	if (imageAspect && columns <= availableColumns) {
		sizeParameter = `r=${rows}`;
	} else {
		columns = availableColumns;
		rows = imageAspect ? Math.max(1, Math.round(columns / Math.max(0.01, imageAspect * 2))) : availableRows;
		sizeParameter = imageAspect ? `c=${columns}` : `c=${columns},r=${rows}`;
	}
	const left = Math.max(0, Math.floor((availableColumns - columns) / 2));
	const top = Math.max(0, Math.floor((availableRows - rows) / 2));
	const chunkSize = 4096;
	stdout.write(`\u001b[${Math.max(1, area.y + 1 + top)};${Math.max(1, area.x + 2 + left)}H`);
	for (let offset = 0; offset < encoded.length; offset += chunkSize) {
		const chunk = encoded.slice(offset, offset + chunkSize);
		const more = offset + chunk.length < encoded.length ? 1 : 0;
		const parameters = offset === 0 ? `a=T,f=100,i=${imageId},${sizeParameter},C=1,q=2,m=${more}` : `q=2,m=${more}`;
		stdout.write(`\u001b_G${parameters};${chunk}\u001b\\`);
	}
}

function pngDimensions(bytes: Buffer): {width: number; height: number} | undefined {
	if (bytes.length < 24 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return undefined;
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	return width > 0 && height > 0 ? {width, height} : undefined;
}

function copyToClipboard(value: string, stdout: NodeJS.WriteStream): void {
	const encoded = Buffer.from(value, 'utf8').toString('base64');
	stdout.write(`\u001b]52;c;${encoded}\u0007`);
	const command = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'powershell.exe' : process.env.WAYLAND_DISPLAY ? 'wl-copy' : process.env.DISPLAY ? 'xclip' : undefined;
	if (!command) return;
	const args = command === 'xclip'
		? ['-selection', 'clipboard']
		: command === 'powershell.exe'
			? powershellArgs('[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())')
			: [];
	try {
		const child = spawn(command, args, {stdio: ['pipe', 'ignore', 'ignore']});
		child.once('error', () => undefined);
		child.stdin?.end(value);
	} catch {
		// OSC 52 above remains the portable terminal fallback.
	}
}

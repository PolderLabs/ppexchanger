export type PeerId = string;

export type PeerStatus = 'discovered' | 'connecting' | 'connected' | 'offline';

export interface Identity {
	name: string;
	secretKey: Buffer;
	publicKey: Buffer;
	peerId: PeerId;
	fingerprint: string;
}

export interface Peer {
	peerId: PeerId;
	name: string;
	hostname: string;
	address: string;
	port: number;
	publicKey: Buffer;
	fingerprint: string;
	status: PeerStatus;
	trusted: boolean;
	lastSeen: number;
}

export interface Message {
	id: string;
	peerId: PeerId;
	direction: 'incoming' | 'outgoing' | 'system';
	body: string;
	fullBody?: string;
	kind?: 'text' | 'pasted-text' | 'file';
	filePath?: string;
	fileName?: string;
	fileMime?: string;
	filePreview?: string;
	fileImageWidth?: number;
	fileImageHeight?: number;
	createdAt: number;
}

export type ThemeName = 'amber' | 'ocean' | 'mono';

export interface UiSettings {
	theme: ThemeName;
	showSidebar: boolean;
	compactMode: boolean;
	showHints: boolean;
	notifications: boolean;
	maxMessages: number;
	showFooter: boolean;
	statusFormat: 'name' | 'name+addr' | 'off';
	scrollback: number;
	sidebarBreakpoint: number;
	minChatWidth: number;
	notifySound: boolean;
	desktopNotifications: boolean;
	imagePreviews: boolean;
	autoTrustSeen: boolean;
}

export interface ChatSnapshot {
	peerId: PeerId;
	messages: Message[];
}

export interface FileOffer {
	id: string;
	name: string;
	size: number;
	mime?: string;
}

export type NetworkEvent =
	| {type: 'peer'; peer: Peer}
	| {type: 'peer-status'; peerId: PeerId; status: PeerStatus}
	| {type: 'message'; peerId: PeerId; body: string; direction: 'incoming' | 'outgoing'}
	| {type: 'file-offer'; peerId: PeerId; offer: FileOffer}
	| {type: 'file-received'; peerId: PeerId; name: string; path: string; size: number; mime?: string}
	| {type: 'file-sent'; peerId: PeerId; name: string; path: string; size: number; mime?: string}
	| {type: 'status'; message: string}
	| {type: 'error'; message: string};

export interface PeerRecord {
	peerId: PeerId;
	name: string;
	hostname: string;
	address: string;
	port: number;
	publicKey: string;
	fingerprint: string;
	trusted: boolean;
	lastSeen: number;
}

export interface StoredState {
	version: 1;
	identity: {name: string; secretKey: string};
	peers: PeerRecord[];
	messages: Message[];
	settings?: UiSettings;
}

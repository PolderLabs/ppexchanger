#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import {App} from './app.js';
import {NetworkService} from './network.js';
import {configDirectory, loadState} from './storage.js';

const VERSION = '1.0.0';

function help(): void {
	console.log(`ppexchanger ${VERSION} — private, encrypted LAN messenger\n\nUsage:\n  ppx [options]\n\nOptions:\n  --name <name>      display name for this session\n  --port <port>      TCP port (default: 47391; 0 selects an ephemeral port)\n  --config <path>    state directory (default: platform config directory)\n  --gen-identity     create identity and print its fingerprint\n  --check            bind network sockets, print readiness, and exit\n  --version, -V      print version\n  --help, -h         print this help\n\nIn the app: press ? for commands and keyboard help.`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let name: string | undefined;
	let directory: string | undefined;
	let port = 47391;
	let genIdentity = false;
	let checkOnly = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		switch (argument) {
			case '--help': case '-h': help(); return;
			case '--version': case '-V': console.log(`ppexchanger ${VERSION}`); return;
			case '--gen-identity': genIdentity = true; break;
			case '--check': checkOnly = true; break;
			case '--name': name = requireValue(args[++index], '--name'); break;
			case '--config': directory = requireValue(args[++index], '--config'); break;
			case '--port': {
				const parsed = Number(requireValue(args[++index], '--port'));
				if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error('--port must be between 0 and 65535');
				port = parsed;
				break;
			}
			default: throw new Error(`unknown argument: ${argument}`);
		}
	}
	const stateDirectory = configDirectory(directory);
	const state = await loadState(stateDirectory, name);
	if (genIdentity) {
		console.log(`identity ready\n  name: ${state.identity.name}\n  peer id: ${state.identity.peerId}\n  fingerprint: ${state.identity.fingerprint}\n  state: ${stateDirectory}`);
		return;
	}
	const network = new NetworkService(state.identity, port, stateDirectory);
	try {
		await network.start();
	} catch (error) {
		console.error(`Could not start ppx: ${(error as Error).message}`);
		await network.stop();
		process.exitCode = 1;
		return;
	}
	if (checkOnly) {
		console.log(`ppx ready: ${state.identity.name} listening on ${network.localPort}; discovery ${stateDirectory}`);
		await network.stop();
		return;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error('ppx needs an interactive terminal. Use --check for a non-interactive readiness check.');
		await network.stop();
		process.exitCode = 1;
		return;
	}
	const instance = render(<App identity={state.identity} directory={stateDirectory} peers={state.peers} messages={state.messages} messageCounts={state.messageCounts} settings={state.settings} network={network} />, {exitOnCtrlC: false, alternateScreen: true, incrementalRendering: true});
	await instance.waitUntilExit();
}

function requireValue(value: string | undefined, flag: string): string {
	if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
	return value;
}

main().catch(error => {
	console.error(`ppx: ${(error as Error).message}`);
	process.exitCode = 2;
});

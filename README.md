# ppexchanger

Private, encrypted LAN messaging for the terminal. The application is a strict TypeScript/Node.js service with an Ink interface.

It has no account, hosted service, or telemetry. Devices announce themselves with a small UDP beacon, establish an authenticated X25519 session over TCP, and protect messages and file transfers with ChaCha20-Poly1305. Identity, contacts, and bounded message history are stored locally under the platform config directory.

## Install and run

Requirements: Node.js 20 or newer. Linux, macOS, and Windows are supported; use a modern terminal with VT input support (Windows Terminal, WezTerm, Ghostty, Kitty, or a comparable terminal).

```sh
npm install --global ppexchanger
ppx
```

From a checkout:

```sh
npm ci
npm run build
node dist/cli.js
```

Useful commands:

```sh
ppx --help
ppx --version
ppx --gen-identity
ppx --check --port 0
```

`--check` binds the TCP and UDP sockets, confirms readiness, and exits. It is useful for service checks and CI environments that do not have a TTY.

## Test messaging in two local terminals

Build once, then run these commands in separate terminals:

```sh
# Terminal 1
npm run dev:alice

# Terminal 2
npm run dev:bob
```

Alice and Bob use separate identities and state directories under `.local/`, share the local UDP discovery channel, and listen on TCP ports `47392` and `47393`. Wait for each name to appear in the other terminal’s PEERS sidebar, select it, and press `c` to connect. Then type a message and press Enter. You can also test file transfer by dragging a file into the composer and accepting it in the other terminal.

To start over with fresh local identities, remove `.local/ppx-alice` and `.local/ppx-bob` before launching the pair again.

## In the app

- `j` / `k` or the arrow keys select a nearby peer.
- `c` connects to the selected peer.
- Enter sends the current message.
- The interface uses the full terminal, with a peer sidebar, conversation pane, composer, settings view, and help view.
- Click peers, the composer, top-bar `Settings`/`help`, settings rows, file actions, and command suggestions with the mouse.
- Type `/` or `/h` in the composer for an arrow-key and mouse-selectable command popup; Enter fills the selected command.
- Paste text directly into the composer; long or multiline pastes are shown as a compact preview while the full original is sent and remains available through the message `[copy]` action.
- Drag or paste file paths and `file://` URLs into the composer to queue files, including images; supported pasted `data:image/*;base64,...` payloads are staged locally too, then press Enter to send them.
- `Ctrl+V` reads text, copied files, and clipboard images through native desktop clipboard APIs on Windows and Linux/Wayland, with terminal clipboard fallback where available.
- `Ctrl+Backspace` removes the previous word in the composer.
- `,` opens settings; `b` toggles the sidebar; `Tab` cycles focus; `Esc` closes views or clears the composer.
- `/connect NAME`, `/peers`, `/discover`, `/name NAME`, and `/send PATH` are available commands.
- Incoming files require an explicit accept (`Enter` or `a`) or reject (`Esc` or `r`).
- `?` opens the keyboard guide; `Ctrl-C` exits cleanly.

Messages and received files never leave the local devices. Received files are written below the configured state directory in `received/` with sanitized names.

Inline image rendering depends on terminal graphics support. Kitty, Ghostty, and WezTerm can display native previews; terminals without the Kitty graphics protocol, including Windows Terminal, retain the image message and its open/reveal actions without attempting unsupported escape sequences.

## Development

```sh
npm run check
npm test
npm run build
```

The tests cover protocol framing, beacon validation, key agreement, AEAD authentication, durable state, encrypted text delivery, and an end-to-end file transfer between two local services.

## Network contract

- UDP discovery: `239.255.42.99:47391`.
- TCP peer sessions: port `47391` by default; pass `--port 0` for an ephemeral listener.
- The persisted public-key fingerprint is the short value shown in the header and peer list. A stored peer whose public key changes is rejected instead of silently trusted.

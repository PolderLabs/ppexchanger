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

Alice and Bob use separate identities and state directories under `.local/`, share the local UDP discovery channel, and listen on TCP ports `47392` and `47393`. Wait for each name to appear in the other terminal's PEERS sidebar. Selecting a discovered peer from the list with `↑`/`↓` initiates a TCP session; alternatively, type `/connect <peer name>` in either terminal to start the session from the composer. Then type a message and press `Enter`. You can also test file transfer by dragging a file into the composer and accepting it in the other terminal.

To start over with fresh local identities, remove `.local/ppx-alice` and `.local/ppx-bob` before launching the pair again.

## In the app

The keybindings below are global to the chat view. Most commands are also available through the slash-command popup (type `/` in the composer for an autocomplete).

### Movement and focus

- `↑` / `↓` move through discovered peers in the sidebar.
- `Tab` / `Shift+Tab` cycles focus between the peer sidebar and the composer.
- `Enter` focuses the composer, sends the current message, or activates the selected setting.
- `PgUp` / `PgDn` scroll the current conversation.

### Messaging

- Type and press `Enter` to send. Long or multiline pastes show a compact preview; the full original is preserved and sent intact.
- `Ctrl+V` reads text, copied files, and clipboard images from the native desktop clipboard: Windows PowerShell, Linux (X11 and Wayland), and macOS (`pbpaste`/`pbcopy`).

### Composer

- Paste text, file paths, `file://` URLs, and `data:image/*;base64,...` payloads directly into the composer; Enter sends them.
- `Backspace` and `Delete` remove one character; `Ctrl+W`, `Ctrl+H`, and `Ctrl+Backspace` remove the previous word.
- `Esc` clears the composer and any queued attachments.

### Peers

- Selecting a discovered peer from the sidebar initiates a connection automatically.
- Type `/connect <name or peer-id>` to connect to a specific peer (also useful for name collisions).
- `Del` or `Ctrl+X` on a selected peer removes it (with confirmation).
- `Ctrl+D` triggers a fresh LAN discovery scan.
- `Ctrl+B` collapses or expands the sidebar.

### File transfer

- Drag a file into the terminal or paste a path to queue it; press `Enter` to send. Use `/send <path>` from the composer too.
- Incoming files show an accept/reject prompt: `Enter` or `a` accepts, `Esc` or `r` rejects.
- The received-file viewer supports `o` to open the file with the system viewer, `l` to reveal its location in the file manager, `j`/`k` or arrow keys to scroll, `←`/`→` to pan wide text, and `Home`/`End` to jump.

### Settings and help

- `,` opens the settings view; `Esc` or `,` again closes it.
- `/help` opens the keyboard guide (also reachable from the top bar).
- `/settings`, `/peers`, `/discover`, `/name <display name>`, `/send <path>`, `/trust`, `/revoke`, and `/quit` are available from the composer.
- `Ctrl+C` exits the app cleanly.

Messages and received files never leave the local devices. Received files are written below the configured state directory in `received/` with sanitized names.

Inline image rendering depends on terminal graphics support. Kitty, Ghostty, and WezTerm display native previews; terminals without the Kitty graphics protocol, including Windows Terminal, retain the image message and its open/reveal actions without attempting unsupported escape sequences.

## Development

```sh
npm run check   # TypeScript strict type check
npm test        # unit + integration tests (9 tests)
npm run build   # TypeScript → dist/
```

The test suite covers: X25519 key derivation, ChaCha20-Poly1305 AEAD, two-service encrypted session establishment and text delivery, LAN beacon round-trip, encrypted frame sequence ordering, beacon validation, durable state with identity persistence, file-name sanitization, and message history pagination.

## Network contract

- UDP discovery: `239.255.42.99:47391`.
- TCP peer sessions: port `47391` by default; pass `--port 0` for an ephemeral listener.
- The persisted public-key fingerprint is the short value shown in the header and peer list. A stored peer whose public key changes is rejected instead of silently trusted.

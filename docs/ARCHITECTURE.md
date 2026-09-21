# Architecture

`ppexchanger` is a single-process TypeScript/Node.js application built on React/Ink. There is one shipped binary, `ppx`, that runs entirely on the local machine — no server, no account, no telemetry.

## Process model

```
src/
  cli.tsx        # entry: argv parsing, --check / --gen-identity
  app.tsx        # Ink UI, keyboard, rendering
  network.ts     # UDP discovery, TCP listener, framed sessions, file transfer
  crypto.ts      # X25519, ChaCha20-Poly1305, HKDF, fingerprint/peerId
  protocol.ts    # wire constants (DISCOVERY_GROUP/PORT), beacon + frame codecs
  storage.ts     # identity, contacts, messages, settings — atomic JSON writes
  types.ts       # shared interface definitions
test/
  protocol/crypto/storage/network  # unit + a real end-to-end transfer test
```

The CLI spawns a single `NetworkService` and hands it to the `App` component. The network service emits `NetworkEvent` values; the UI reduces them into React state.

## Discovery and transport

- **Discovery.** Every minute `ppx` emits a UDP beacon to `239.255.42.99:47391` containing its name, host, TCP port, public key, and a monotonic version. Peers whose stored public key differs from the beacon are dropped from the trusted set.
- **Transport.** Each peer opens a TCP listener on `47391` (overridable with `--port`). Connections run length-prefixed frames: a 4-byte magic + version handshake, then AEAD-encrypted frames carrying JSON message envelopes or file-transfer chunks.

## Crypto

- **Identity.** 32-byte X25519 keypair, generated on first run, persisted as raw bytes under the platform config directory. The peer ID is the first 16 hex chars of `SHA-256(publicKey)`.
- **Fingerprint.** First 8 hex chars of `SHA-256(publicKey)`. Shown in the header and peer list. The UI rejects any stored peer whose public key changes instead of silently re-trusting it.
- **Session keys.** `X25519(ephemeralSecret, remoteStatic) || X25519(staticSecret, remoteEphemeral)` feeds HKDF-SHA256 with a transcript label to derive independent send/receive AEAD keys (direction-separated to prevent reflection).
- **AEAD.** ChaCha20-Poly1305 with the 12-byte nonce derived from the same HKDF info and a per-direction counter. The transcript MAC authenticates the entire handshake and is bound into the AEAD key.

## File transfer

After `file-offer` is accepted by the receiver, the sender streams the file as 64 KiB frames; the receiver writes to a `tmp.<sha>` path under the configured state directory and renames to `received/<sanitized-name>` after a SHA-256 of the assembled bytes matches the offer. Cancel and disconnect paths discard the partial file.

## Storage

`StoredState` is held in `state.json` under the platform config directory; every write goes to `state.json.tmp` then `rename`, so a crash mid-write leaves the previous state intact. File paths are sanitized on read and on receive.

## TUI

The `App` component owns all UI state (peers, messages, settings, focused pane, modal views). Ink renders to the active TTY; non-TTY paths go through `--check` which verifies socket readiness and exits without entering the React tree.

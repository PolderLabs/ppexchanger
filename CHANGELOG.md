# Changelog

## 1.0.0 — 2026-09-21

- Replaced the Rust/ratatui application with a strict TypeScript/Node.js implementation built on Ink.
- Full peer lifecycle: LAN beacon discovery (UDP multicast `239.255.42.99:47391`), X25519 session negotiation, ChaCha20-Poly1305 framed messages and file transfer, public-key change rejection.
- Durable identity, contact, conversation, and received-file storage with atomic state writes.
- Encrypted text and file-transfer integration tests, Node/TypeScript CI, and npm provenance publishing.
- Cross-platform clipboard support (Windows PowerShell, Linux and macOS native), with terminal capability-gated inline image rendering.
- Composer accepts pasted text, file paths, `file://` URLs, and base64 image payloads; long pastes are previewed while the full original is preserved.

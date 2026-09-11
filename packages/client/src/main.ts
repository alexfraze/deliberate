/**
 * Client entry point. TODO(ALE-12): three.js WebGPU renderer with WebGL fallback, isometric
 * camera, grid rendering from the snapshot, placeholder entity meshes, tile hover/select input,
 * and a diff-driven animation queue. The client never holds authoritative state: it renders the
 * last snapshot plus the diff stream, and every action goes to the server as an `intent`.
 */
import { REVISION } from 'three';

import { DEFAULT_ROOM, PROTOCOL_VERSION } from '@deliberate/protocol';

import { encodeClientMessage, parseServerMessage } from './messages.js';

const hud = document.getElementById('hud');
if (hud) hud.textContent = `three r${REVISION} · protocol v${PROTOCOL_VERSION} · not connected`;

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const socket = new WebSocket(wsUrl);
socket.addEventListener('open', () => {
  socket.send(
    encodeClientMessage({ type: 'join', room: DEFAULT_ROOM, protocol: PROTOCOL_VERSION }),
  );
});
socket.addEventListener('message', (event) => {
  const message = parseServerMessage(String(event.data));
  if (!message) return;
  if (hud) hud.textContent = `three r${REVISION} · protocol v${PROTOCOL_VERSION} · ${message.type}`;
});

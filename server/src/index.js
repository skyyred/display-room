import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import express from 'express';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { ensureCerts } from './utils/certs.js';
import { isPrivateIPv4 } from './utils/network.js';
import { initMediasoup, getRouter, createWebRtcTransport } from './mediasoup/mediasoupManager.js';
import { getRuntimeRoom, removePeer } from './mediasoup/roomRuntime.js';
import { authenticateJoin } from './services/authService.js';
import { addChatMessage, getChatHistory } from './services/chatService.js';
import { getOrCreateRoom, listRooms, setRoomWatermark, validateRoomName } from './services/roomService.js';


function pickLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const item of iface || []) {
      if (item.family === 'IPv4' && !item.internal) {
        const ip = item.address;
        if (ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
          return ip;
        }
      }
    }
  }
  return undefined;
}

function normalizeAnnouncedAddress(hostValue) {
  if (!hostValue) return undefined;
  const h = hostValue.trim().toLowerCase();
  if (!h || h === '0.0.0.0' || h === 'localhost' || h === '127.0.0.1' || h === '::1') return undefined;
  return hostValue;
}

const app = express();
app.use(express.json());

const clientPath = path.resolve(process.cwd(), '..', 'client', 'public');
app.use(express.static(clientPath));

app.get('/api/rooms', (_req, res) => res.json({ rooms: listRooms() }));

app.post('/api/rooms', (req, res) => {
  const { roomName } = req.body;
  if (!validateRoomName(roomName)) {
    return res.status(400).json({ error: 'Room name must contain only letters and numbers.' });
  }
  const room = getOrCreateRoom(roomName);
  return res.json({ roomName: room.name });
});

await initMediasoup();

const httpsServer = https.createServer(ensureCerts(), app);
const io = new Server(httpsServer);

io.on('connection', (socket) => {
  const remoteIp = socket.handshake.address;
  if (env.PRIVATE_ONLY && !isPrivateIPv4(remoteIp)) {
    socket.emit('serverWarning', 'Non-private client IP detected. This service is intended for local networks.');
  }

  socket.data = { transports: new Map(), consumers: new Map(), producer: null, roomName: null, displayName: null, roomId: null };

  socket.on('joinRoom', async ({ roomName, displayName }, cb) => {
    console.log(`[room] join request socket=${socket.id} room=${roomName} user=${displayName}`);
    const auth = authenticateJoin({ displayName });
    if (!auth.ok) return cb({ error: auth.error });
    if (!validateRoomName(roomName)) return cb({ error: 'Invalid room name.' });

    const persistedRoom = getOrCreateRoom(roomName);
    const state = getRuntimeRoom(roomName);

    socket.join(roomName);
    socket.data.roomName = roomName;
    socket.data.displayName = displayName;
    socket.data.roomId = persistedRoom.id;
    state.peers.set(socket.id, { socketId: socket.id, displayName });

    cb({
      routerRtpCapabilities: getRouter().rtpCapabilities,
      presenterSocketId: state.presenterSocketId,
      participants: [...state.peers.values()],
      chatHistory: getChatHistory(persistedRoom.id),
      watermarkEnabled: persistedRoom.watermarkEnabled,
      activeProducers: [...state.producers.values()].map((p) => ({ id: p.id, kind: p.kind }))
    });

    console.log(`[room] joined socket=${socket.id} room=${roomName} peers=${state.peers.size} presenter=${state.presenterSocketId ?? 'none'} activeProducer=${state.producer?.id ?? 'none'}`);
    io.to(roomName).emit('presenceUpdate', {
      participants: [...state.peers.values()],
      presenterSocketId: state.presenterSocketId
    });
  });

  socket.on('requestPresenter', (_payload, cb) => {
    console.log(`[presenter] request socket=${socket.id} room=${socket.data.roomName}`);
    const roomName = socket.data.roomName;
    if (!roomName) return cb({ error: 'Join a room first.' });
    const state = getRuntimeRoom(roomName);

    if (!state.presenterSocketId) {
      state.presenterSocketId = socket.id;
      console.log(`[presenter] auto-approved socket=${socket.id} room=${roomName}`);
      io.to(roomName).emit('presenterUpdate', { presenterSocketId: socket.id });
      return cb({ approved: true });
    }
    if (state.presenterSocketId === socket.id) return cb({ approved: true });

    state.pendingPresenterRequest = { requesterId: socket.id };
    io.to(state.presenterSocketId).emit('presenterApprovalNeeded', { requesterId: socket.id, requesterName: socket.data.displayName });
    cb({ approved: false, pending: true });
  });

  socket.on('respondPresenterRequest', ({ requesterId, approved }) => {
    const roomName = socket.data.roomName;
    if (!roomName) return;
    const state = getRuntimeRoom(roomName);
    if (state.presenterSocketId !== socket.id) return;
    if (!state.pendingPresenterRequest || state.pendingPresenterRequest.requesterId !== requesterId) return;

    state.pendingPresenterRequest = null;
    if (!approved) return io.to(requesterId).emit('presenterRequestResult', { approved: false });

    const prevPresenter = state.presenterSocketId;
    state.presenterSocketId = requesterId;
    state.producers.forEach((producer) => producer.close());
    state.producers.clear();
    io.to(prevPresenter).emit('forceStopShare');
    io.to(roomName).emit('presenterUpdate', { presenterSocketId: requesterId });
    io.to(requesterId).emit('presenterRequestResult', { approved: true });
  });

  socket.on('createTransport', async ({ direction }, cb) => {
    console.log(`[webrtc] createTransport socket=${socket.id} dir=${direction} room=${socket.data.roomName}`);
    const hostHeader = socket.handshake.headers.host || '';
    const hostFromHeader = normalizeAnnouncedAddress(hostHeader.split(':')[0]);
    const announcedAddress = normalizeAnnouncedAddress(env.MEDIA_ANNOUNCED_IP) || hostFromHeader || pickLanIp();
    const transport = await createWebRtcTransport(announcedAddress);
    socket.data.transports.set(transport.id, transport);
    transport.on('dtlsstatechange', (state) => state === 'closed' && transport.close());
    console.log(`[webrtc] transport created socket=${socket.id} id=${transport.id} dir=${direction} announced=${announcedAddress ?? '(none)'} candidates=${transport.iceCandidates?.length ?? 0}`);
    cb({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters, direction });
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    console.log(`[webrtc] connectTransport socket=${socket.id} transport=${transportId}`);
    const transport = socket.data.transports.get(transportId);
    await transport.connect({ dtlsParameters });
    cb({ ok: true });
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    console.log(`[webrtc] produce request socket=${socket.id} room=${socket.data.roomName} transport=${transportId} kind=${kind}`);
    const roomName = socket.data.roomName;
    const state = getRuntimeRoom(roomName);
    if (state.presenterSocketId !== socket.id) return cb({ error: 'Only presenter can produce.' });
    const transport = socket.data.transports.get(transportId);
    const producer = await transport.produce({ kind, rtpParameters });
    if (kind === 'video' && state.producers.has('video')) state.producers.get('video').close();
    if (kind === 'audio' && state.producers.has('audio')) state.producers.get('audio').close();
    state.producers.set(kind, producer);
    producer.on('transportclose', () => producer.close());
    producer.on('close', () => { if (state.producers.get(kind)?.id === producer.id) state.producers.delete(kind); });
    console.log(`[webrtc] producer created socket=${socket.id} room=${roomName} producer=${producer.id} kind=${kind}`);
    io.to(roomName).emit('newPresenterStream', { producerId: producer.id, kind: producer.kind });
    cb({ id: producer.id });
  });

  socket.on('consume', async ({ producerId, transportId, rtpCapabilities }, cb) => {
    console.log(`[webrtc] consume request socket=${socket.id} room=${socket.data.roomName} producer=${producerId} transport=${transportId}`);
    if (!getRouter().canConsume({ producerId, rtpCapabilities })) return cb({ error: 'Cannot consume this producer.' });
    const transport = socket.data.transports.get(transportId);
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
    console.log(`[webrtc] consume ok socket=${socket.id} consumer=${consumer.id} kind=${consumer.kind}`);
    socket.data.consumers.set(consumer.id, consumer);
    cb({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
  });

  socket.on('sendChat', ({ message }) => {
    if (!socket.data.roomName || !message?.trim()) return;
    addChatMessage(socket.data.roomId, socket.data.displayName, message.trim());
    io.to(socket.data.roomName).emit('chatMessage', { author: socket.data.displayName, message: message.trim(), created_at: new Date().toISOString() });
  });

  socket.on('setWatermark', ({ enabled }) => {
    if (!socket.data.roomName) return;
    setRoomWatermark(socket.data.roomId, !!enabled);
    io.to(socket.data.roomName).emit('watermarkUpdate', { enabled: !!enabled, roomName: socket.data.roomName });
  });

  socket.on('disconnect', () => {
    const roomName = socket.data.roomName;
    if (!roomName) return;
    const state = getRuntimeRoom(roomName);
    const wasPresenter = state.presenterSocketId === socket.id;
    socket.data.transports.forEach((t) => t.close());
    socket.data.consumers.forEach((c) => c.close());
    if (socket.data.producer) socket.data.producer.close();
    removePeer(roomName, socket.id);

    console.log(`[room] joined socket=${socket.id} room=${roomName} peers=${state.peers.size} presenter=${state.presenterSocketId ?? 'none'} activeProducer=${state.producer?.id ?? 'none'}`);
    io.to(roomName).emit('presenceUpdate', { participants: [...state.peers.values()], presenterSocketId: state.presenterSocketId });
    if (wasPresenter) io.to(roomName).emit('presenterUpdate', { presenterSocketId: null });
  });
});

httpsServer.listen(env.HTTPS_PORT, env.HOST, () => {
  console.log(`[startup] https://${env.HOST}:${env.HTTPS_PORT}`);
  console.log(`[startup] mediasoup listen=${env.MEDIA_LISTEN_IP} announced=${env.MEDIA_ANNOUNCED_IP || '(none)'}`);
  if (!normalizeAnnouncedAddress(env.MEDIA_ANNOUNCED_IP)) console.warn(`[startup] MEDIA_ANNOUNCED_IP is empty/invalid. Using detected LAN fallback: ${pickLanIp() || '(none)'}. Set MEDIA_ANNOUNCED_IP to host LAN IP for best reliability.`);
  if (fs.existsSync(clientPath)) console.log(`[startup] serving client from ${clientPath}`);
});

import fs from 'node:fs';
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
      watermarkEnabled: persistedRoom.watermarkEnabled
    });

    io.to(roomName).emit('presenceUpdate', {
      participants: [...state.peers.values()],
      presenterSocketId: state.presenterSocketId
    });
  });

  socket.on('requestPresenter', (_payload, cb) => {
    const roomName = socket.data.roomName;
    if (!roomName) return cb({ error: 'Join a room first.' });
    const state = getRuntimeRoom(roomName);

    if (!state.presenterSocketId) {
      state.presenterSocketId = socket.id;
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
    if (state.producer) {
      state.producer.close();
      state.producer = null;
    }
    io.to(prevPresenter).emit('forceStopShare');
    io.to(roomName).emit('presenterUpdate', { presenterSocketId: requesterId });
    io.to(requesterId).emit('presenterRequestResult', { approved: true });
  });

  socket.on('createTransport', async ({ direction }, cb) => {
    const transport = await createWebRtcTransport();
    socket.data.transports.set(transport.id, transport);
    transport.on('dtlsstatechange', (state) => state === 'closed' && transport.close());
    cb({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters, direction });
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
    const transport = socket.data.transports.get(transportId);
    await transport.connect({ dtlsParameters });
    cb({ ok: true });
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters }, cb) => {
    const roomName = socket.data.roomName;
    const state = getRuntimeRoom(roomName);
    if (state.presenterSocketId !== socket.id) return cb({ error: 'Only presenter can produce.' });
    const transport = socket.data.transports.get(transportId);
    const producer = await transport.produce({ kind, rtpParameters });
    socket.data.producer = producer;
    if (state.producer) state.producer.close();
    state.producer = producer;
    producer.on('transportclose', () => producer.close());
    io.to(roomName).emit('newPresenterStream', { producerId: producer.id });
    cb({ id: producer.id });
  });

  socket.on('consume', async ({ producerId, transportId, rtpCapabilities }, cb) => {
    if (!getRouter().canConsume({ producerId, rtpCapabilities })) return cb({ error: 'Cannot consume this producer.' });
    const transport = socket.data.transports.get(transportId);
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });
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

    io.to(roomName).emit('presenceUpdate', { participants: [...state.peers.values()], presenterSocketId: state.presenterSocketId });
    if (wasPresenter) io.to(roomName).emit('presenterUpdate', { presenterSocketId: null });
  });
});

httpsServer.listen(env.HTTPS_PORT, env.HOST, () => {
  console.log(`[startup] https://${env.HOST}:${env.HTTPS_PORT}`);
  console.log(`[startup] mediasoup listen=${env.MEDIA_LISTEN_IP} announced=${env.MEDIA_ANNOUNCED_IP || '(none)'}`);
  if (fs.existsSync(clientPath)) console.log(`[startup] serving client from ${clientPath}`);
});

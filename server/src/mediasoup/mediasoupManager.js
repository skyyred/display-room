import * as mediasoup from 'mediasoup';
import { env } from '../config/env.js';

let worker;
let router;

export async function initMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: env.MEDIA_MIN_PORT,
    rtcMaxPort: env.MEDIA_MAX_PORT,
    logLevel: 'warn',
    logTags: ['ice', 'dtls', 'rtp', 'srtp', 'rtcp']
  });

  worker.on('died', () => {
    console.error('[mediasoup] worker died, exiting in 2s');
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({
    mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
    ]
  });

  return { worker, router };
}

export function getRouter() {
  return router;
}

export async function createWebRtcTransport() {
  return router.createWebRtcTransport({
    listenInfos: [{
      protocol: 'udp',
      ip: env.MEDIA_LISTEN_IP,
      announcedAddress: env.MEDIA_ANNOUNCED_IP || undefined
    }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true
  });
}

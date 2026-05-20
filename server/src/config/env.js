import dotenv from 'dotenv';

dotenv.config();

const parseList = (value, fallback) => {
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
};

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  HTTPS_PORT: Number(process.env.HTTPS_PORT ?? 8443),
  HOST: process.env.HOST ?? '0.0.0.0',
  DB_PATH: process.env.DB_PATH ?? '/app/data/display-room.db',
  CERT_PATH: process.env.CERT_PATH ?? '/app/certs/server.crt',
  KEY_PATH: process.env.KEY_PATH ?? '/app/certs/server.key',
  MEDIA_LISTEN_IP: process.env.MEDIA_LISTEN_IP ?? '0.0.0.0',
  MEDIA_ANNOUNCED_IP: process.env.MEDIA_ANNOUNCED_IP ?? '',
  MEDIA_MIN_PORT: Number(process.env.MEDIA_MIN_PORT ?? 40000),
  MEDIA_MAX_PORT: Number(process.env.MEDIA_MAX_PORT ?? 40100),
  MEDIA_CODECS: parseList(process.env.MEDIA_CODECS, ['video/VP8', 'audio/opus']),
  PRIVATE_ONLY: process.env.PRIVATE_ONLY !== 'false'
};

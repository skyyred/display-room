import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { env } from '../config/env.js';

export function ensureCerts() {
  const certDir = path.dirname(env.CERT_PATH);
  const keyDir = path.dirname(env.KEY_PATH);
  fs.mkdirSync(certDir, { recursive: true });
  fs.mkdirSync(keyDir, { recursive: true });

  if (!fs.existsSync(env.CERT_PATH) || !fs.existsSync(env.KEY_PATH)) {
    console.log('[https] generating self-signed cert');
    execSync(`openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -keyout ${env.KEY_PATH} -out ${env.CERT_PATH} -subj '/CN=display-room-local'`);
  }

  return {
    cert: fs.readFileSync(env.CERT_PATH),
    key: fs.readFileSync(env.KEY_PATH)
  };
}

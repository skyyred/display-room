import { db } from '../db/sqlite.js';

const nameRegex = /^[A-Za-z0-9]+$/;

const insertRoom = db.prepare('INSERT INTO rooms (name) VALUES (?)');
const findRoom = db.prepare('SELECT * FROM rooms WHERE name = ?');
const findRoomById = db.prepare('SELECT * FROM rooms WHERE id = ?');
const listRoomsStmt = db.prepare('SELECT name, created_at FROM rooms ORDER BY name ASC');
const upsertSettings = db.prepare(`
  INSERT INTO room_settings (room_id, watermark_enabled, updated_at)
  VALUES (?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(room_id) DO UPDATE SET
  watermark_enabled = excluded.watermark_enabled,
  updated_at = CURRENT_TIMESTAMP
`);
const getSettings = db.prepare('SELECT watermark_enabled FROM room_settings WHERE room_id = ?');

export function validateRoomName(name) {
  return nameRegex.test(name);
}

export function getOrCreateRoom(name) {
  let room = findRoom.get(name);
  if (!room) {
    const info = insertRoom.run(name);
    room = findRoomById.get(info.lastInsertRowid);
  }
  const settings = getSettings.get(room.id) ?? { watermark_enabled: 0 };
  return { ...room, watermarkEnabled: Boolean(settings.watermark_enabled) };
}

export function listRooms() {
  return listRoomsStmt.all();
}

export function setRoomWatermark(roomId, enabled) {
  upsertSettings.run(roomId, enabled ? 1 : 0);
}

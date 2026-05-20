import { db } from '../db/sqlite.js';

const insertChat = db.prepare('INSERT INTO chat_messages (room_id, author, message) VALUES (?, ?, ?)');
const listChat = db.prepare('SELECT author, message, created_at FROM chat_messages WHERE room_id = ? ORDER BY id ASC LIMIT 200');

export function addChatMessage(roomId, author, message) {
  insertChat.run(roomId, author, message);
}

export function getChatHistory(roomId) {
  return listChat.all(roomId);
}

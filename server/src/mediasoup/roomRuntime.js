export const runtimeRooms = new Map();

export function getRuntimeRoom(roomName) {
  if (!runtimeRooms.has(roomName)) {
    runtimeRooms.set(roomName, {
      peers: new Map(),
      presenterSocketId: null,
      pendingPresenterRequest: null,
      producer: null
    });
  }
  return runtimeRooms.get(roomName);
}

export function removePeer(roomName, socketId) {
  const room = runtimeRooms.get(roomName);
  if (!room) return;
  room.peers.delete(socketId);
  if (room.pendingPresenterRequest?.requesterId === socketId) {
    room.pendingPresenterRequest = null;
  }
  if (room.presenterSocketId === socketId) {
    room.presenterSocketId = null;
    if (room.producer) {
      room.producer.close();
      room.producer = null;
    }
  }
}

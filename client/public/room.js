const qs = new URLSearchParams(location.search);
const roomName = qs.get('room');
const displayName = qs.get('name');
if (!roomName || !displayName) location.href = '/join.html';
roomLabel.textContent = `Room: ${roomName}`;
me.textContent = `You: ${displayName}`;

const socket = io();
let device, sendTransport, recvTransport, producer, stream;
let currentPresenter = null;
let pendingRequester = null;

const call = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));


async function loadMediasoupClient() {
  if (window.mediasoupClient?.Device) return window.mediasoupClient;
  try {
    const mod = await import('https://esm.sh/mediasoup-client@3');
    if (mod?.Device) return mod;
  } catch (error) {
    status.textContent = 'Failed to load mediasoup client library. Check network access to CDN.';
    throw error;
  }
  throw new Error('mediasoup client library unavailable');
}

(async function init(){
  const joined = await call('joinRoom', { roomName, displayName });
  if (joined.error) { status.textContent = joined.error; return; }
  const mediasoupLib = await loadMediasoupClient();
  device = new mediasoupLib.Device();
  await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
  currentPresenter = joined.presenterSocketId;
  renderParticipants(joined.participants, currentPresenter);
  presenter.textContent = currentPresenter ? '(active)' : 'None';
  watermarkToggle.checked = joined.watermarkEnabled;
  setWatermark(joined.watermarkEnabled);
  joined.chatHistory.forEach(addChatLine);

  const sendInfo = await call('createTransport', { direction: 'send' });
  sendTransport = device.createSendTransport(sendInfo);
  sendTransport.on('connect', ({ dtlsParameters }, cb) => call('connectTransport', { transportId: sendInfo.id, dtlsParameters }).then(cb));
  sendTransport.on('produce', ({ kind, rtpParameters }, cb, eb) => call('produce', { transportId: sendInfo.id, kind, rtpParameters }).then((r) => r.error ? eb(r.error) : cb({ id: r.id })));

  const recvInfo = await call('createTransport', { direction: 'recv' });
  recvTransport = device.createRecvTransport(recvInfo);
  recvTransport.on('connect', ({ dtlsParameters }, cb) => call('connectTransport', { transportId: recvInfo.id, dtlsParameters }).then(cb));
})();

requestPresenterBtn.onclick = async () => {
  const result = await call('requestPresenter');
  status.textContent = result.pending ? 'Waiting for presenter approval...' : (result.approved ? 'Presenter granted.' : (result.error || 'Request failed'));
};

startBtn.onclick = async () => {
  try {
    if (!sendTransport) return;
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  }
  const track = stream.getVideoTracks()[0];
  producer = await sendTransport.produce({ track });
  track.onended = () => stopShare();
};

stopBtn.onclick = () => stopShare();
async function stopShare(){ if (producer){ producer.close(); producer = null;} if(stream){stream.getTracks().forEach(t=>t.stop()); stream = null;} remoteVideo.srcObject = null; }

watermarkToggle.onchange = () => socket.emit('setWatermark', { enabled: watermarkToggle.checked });

sendChat.onclick = () => { if (!chatInput.value.trim()) return; socket.emit('sendChat', { message: chatInput.value }); chatInput.value=''; };

socket.on('newPresenterStream', async ({ producerId }) => {
  const res = await call('consume', { producerId, transportId: recvTransport.id, rtpCapabilities: device.rtpCapabilities });
  if (res.error) return status.textContent = res.error;
  const consumer = await recvTransport.consume(res);
  const ms = new MediaStream([consumer.track]);
  remoteVideo.srcObject = ms;
});
socket.on('presenceUpdate', ({ participants, presenterSocketId }) => renderParticipants(participants, presenterSocketId));
socket.on('presenterUpdate', ({ presenterSocketId }) => { currentPresenter = presenterSocketId; presenter.textContent = presenterSocketId ? (presenterSocketId === socket.id ? 'You' : 'Active user') : 'None'; });
socket.on('presenterApprovalNeeded', ({ requesterId, requesterName }) => { pendingRequester = requesterId; approvalText.textContent = `${requesterName} requested presenter role.`; approvalBox.classList.remove('hidden'); });
approveBtn.onclick = ()=>{ socket.emit('respondPresenterRequest',{requesterId:pendingRequester,approved:true}); approvalBox.classList.add('hidden');};
denyBtn.onclick = ()=>{ socket.emit('respondPresenterRequest',{requesterId:pendingRequester,approved:false}); approvalBox.classList.add('hidden');};
socket.on('presenterRequestResult', ({ approved }) => status.textContent = approved ? 'Presenter approved.' : 'Presenter denied your request.');
socket.on('forceStopShare', stopShare);
socket.on('chatMessage', addChatLine);
socket.on('watermarkUpdate', ({ enabled, roomName }) => { watermarkToggle.checked = enabled; setWatermark(enabled, roomName); });
socket.on('serverWarning', (msg) => status.textContent = msg);

function renderParticipants(parts, presenterSocketId){
  participants.innerHTML='';
  parts.forEach((p)=>{ const li=document.createElement('li'); li.textContent = p.displayName + (p.socketId===presenterSocketId?' (Presenter)':''); participants.appendChild(li); });
}
function addChatLine(msg){ const div=document.createElement('div'); div.textContent=`[${new Date(msg.created_at).toLocaleTimeString()}] ${msg.author}: ${msg.message}`; chat.appendChild(div); chat.scrollTop = chat.scrollHeight; }
function setWatermark(enabled, label = roomName){ watermark.textContent = label; watermark.classList.toggle('hidden', !enabled); }

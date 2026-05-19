
const badHostnames = new Set(['0.0.0.0', 'localhost', '127.0.0.1']);
if (badHostnames.has(location.hostname)) {
  document.body.innerHTML = `<div class='card'><h2>Invalid access URL</h2><p>Open this app using the host LAN IP (example: https://10.0.0.118:8443), not ${location.hostname}.</p></div>`;
  throw new Error('Invalid hostname for cross-machine WebRTC');
}

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
let activeProducerIds = [];
let videoConsumer;
let audioConsumer;
let remoteMediaStream = new MediaStream();
let recvReady = false;

function logClient(message, meta) {
  const prefix = `[client:${socket.id || 'pending'}]`;
  if (meta) console.log(prefix, message, meta);
  else console.log(prefix, message);
}

function isCurrentPresenter() {
  return currentPresenter === socket.id;
}

function updatePresenterControls() {
  const mine = isCurrentPresenter();
  startBtn.disabled = !mine;
  stopBtn.disabled = !mine;
  requestPresenterBtn.disabled = mine;
}

const call = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));

async function attachVideoStream(mediaStream, { muted = false } = {}) {
  remoteVideo.srcObject = mediaStream;
  remoteVideo.muted = muted;
  try {
    await remoteVideo.play();
  } catch {
    status.textContent = 'Video attached. Click the video area if playback is blocked by browser autoplay policy.';
  }
}

function loadMediasoupClient() {
  if (window.mediasoupClient?.Device) return window.mediasoupClient;
  status.textContent = 'mediasoup-client bundle missing. Run npm install/build on the server host.';
  throw new Error('mediasoup client library unavailable');
}

(async function init(){
  const joined = await call('joinRoom', { roomName, displayName });
  logClient('joinRoom response', joined);
  if (joined.error) { status.textContent = joined.error; return; }
  const mediasoupLib = loadMediasoupClient();
  device = new mediasoupLib.Device();
  await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
  currentPresenter = joined.presenterSocketId;
  renderParticipants(joined.participants, currentPresenter);
  presenter.textContent = currentPresenter ? '(active)' : 'None';
  updatePresenterControls();
  watermarkToggle.checked = joined.watermarkEnabled;
  activeProducerIds = joined.activeProducers?.map((p) => p.id) || [];
  setWatermark(joined.watermarkEnabled);
  joined.chatHistory.forEach(addChatLine);

  const sendInfo = await call('createTransport', { direction: 'send' });
  logClient('send transport info', sendInfo);
  sendTransport = device.createSendTransport(sendInfo);
  sendTransport.on('connect', ({ dtlsParameters }, cb) => call('connectTransport', { transportId: sendInfo.id, dtlsParameters }).then(cb));
  sendTransport.on('produce', ({ kind, rtpParameters }, cb, eb) => call('produce', { transportId: sendInfo.id, kind, rtpParameters }).then((r) => r.error ? eb(r.error) : cb({ id: r.id })));

  const recvInfo = await call('createTransport', { direction: 'recv' });
  logClient('recv transport info', recvInfo);
  recvTransport = device.createRecvTransport(recvInfo);
  recvTransport.on('connect', ({ dtlsParameters }, cb) => call('connectTransport', { transportId: recvInfo.id, dtlsParameters }).then(() => {
    cb();
    recvReady = true;
    logClient('recv transport connected', { transportId: recvInfo.id });
  }));
  for (const producerId of activeProducerIds) await consumePresenter(producerId);
})();

requestPresenterBtn.onclick = async () => {
  const result = await call('requestPresenter');
  logClient('requestPresenter result', result);
  status.textContent = result.pending ? 'Waiting for presenter approval...' : (result.approved ? 'Presenter granted.' : (result.error || 'Request failed'));
};

startBtn.onclick = async () => {
  if (!isCurrentPresenter()) {
    status.textContent = 'Only the current presenter can start screen sharing.';
    return;
  }

  try {
    if (!sendTransport) return;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    }

    await attachVideoStream(stream, { muted: true });
    const videoTrack = stream.getVideoTracks()[0];
    producer = await sendTransport.produce({ track: videoTrack });
    logClient('video producer started', { producerId: producer.id, trackId: videoTrack.id });
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      const audioProducer = await sendTransport.produce({ track: audioTrack });
      logClient('audio producer started', { producerId: audioProducer.id, trackId: audioTrack.id });
    }
    videoTrack.onended = () => stopShare();
    status.textContent = 'Screen sharing started.';
  } catch (error) {
    status.textContent = typeof error === 'string' ? error : (error?.message || 'Unable to start screen sharing.');
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }
};

stopBtn.onclick = () => stopShare();
async function stopShare(){ if (producer){ producer.close(); producer = null;} if(stream){stream.getTracks().forEach(t=>t.stop()); stream = null;} remoteVideo.srcObject = null; }

watermarkToggle.onchange = () => socket.emit('setWatermark', { enabled: watermarkToggle.checked });

sendChat.onclick = () => { if (!chatInput.value.trim()) return; socket.emit('sendChat', { message: chatInput.value }); chatInput.value=''; };

async function consumePresenter(producerId) {
  if (!recvTransport || !device) return;
  const res = await call('consume', { producerId, transportId: recvTransport.id, rtpCapabilities: device.rtpCapabilities });
  logClient('consume response', res);
  if (res.error) { status.textContent = res.error; return; }
  const consumer = await recvTransport.consume(res);
  if (consumer.kind === 'video') {
    if (videoConsumer) videoConsumer.close();
    videoConsumer = consumer;
    remoteMediaStream.getVideoTracks().forEach((t) => remoteMediaStream.removeTrack(t));
    remoteMediaStream.addTrack(consumer.track);
    await attachVideoStream(remoteMediaStream, { muted: false });
  } else if (consumer.kind === 'audio') {
    if (audioConsumer) audioConsumer.close();
    audioConsumer = consumer;
    remoteMediaStream.getAudioTracks().forEach((t) => remoteMediaStream.removeTrack(t));
    remoteMediaStream.addTrack(consumer.track);
    await attachVideoStream(remoteMediaStream, { muted: false });
  }
}

socket.on('newPresenterStream', async ({ producerId }) => {
  logClient('newPresenterStream event', { producerId, isCurrentPresenter: isCurrentPresenter(), recvReady });
  if (isCurrentPresenter()) return;
  if (!activeProducerIds.includes(producerId)) activeProducerIds.push(producerId);
  await consumePresenter(producerId);
});
socket.on('presenceUpdate', ({ participants, presenterSocketId }) => renderParticipants(participants, presenterSocketId));
socket.on('presenterUpdate', ({ presenterSocketId }) => { logClient('presenterUpdate', { presenterSocketId }); currentPresenter = presenterSocketId; presenter.textContent = presenterSocketId ? (presenterSocketId === socket.id ? 'You' : 'Active user') : 'None'; updatePresenterControls(); });
socket.on('presenterApprovalNeeded', ({ requesterId, requesterName }) => { pendingRequester = requesterId; approvalText.textContent = `${requesterName} requested presenter role.`; approvalBox.classList.remove('hidden'); });
approveBtn.onclick = ()=>{ socket.emit('respondPresenterRequest',{requesterId:pendingRequester,approved:true}); approvalBox.classList.add('hidden');};
denyBtn.onclick = ()=>{ socket.emit('respondPresenterRequest',{requesterId:pendingRequester,approved:false}); approvalBox.classList.add('hidden');};
socket.on('presenterRequestResult', ({ approved }) => { status.textContent = approved ? 'Presenter approved. You can now start sharing.' : 'Presenter denied your request.'; });
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

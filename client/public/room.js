const badHostnames = new Set(['0.0.0.0', 'localhost', '127.0.0.1']);
if (badHostnames.has(location.hostname)) {
  document.body.innerHTML = `<div class='card'><h2>Invalid access URL</h2><p>Open using LAN IP, not ${location.hostname}.</p></div>`;
  throw new Error('Invalid hostname for cross-machine WebRTC');
}

const qs = new URLSearchParams(location.search);
const roomName = qs.get('room');
const displayName = qs.get('name');
if (!roomName || !displayName) location.href = '/join.html';
document.title = `Room ${roomName} - Display Room`;

const socket = io();
let device, sendTransport, recvTransport, videoProducer, stream;
let currentPresenter = null;
let pendingRequester = null;
let participantsList = [];
let presenterDisplayName = null;
let pendingStart = false;

const call = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));

function presenterName() {
  const p = participantsList.find((x) => x.socketId === currentPresenter);
  return p?.displayName || presenterDisplayName || 'None';
}
function renderParticipants(parts, presenterSocketId) {
  participantsList = parts;
  participants.innerHTML = '';
  parts.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.displayName + (p.socketId === presenterSocketId ? ' (Sharing)' : '');
    participants.appendChild(li);
  });
  currentSharer.textContent = presenterName();
}

async function attach(mediaStream, muted = false) {
  remoteVideo.srcObject = mediaStream;
  remoteVideo.muted = muted;
  try { await remoteVideo.play(); } catch {}
}

(async function init() {
  const joined = await call('joinRoom', { roomName, displayName });
  if (joined.error) return (status.textContent = joined.error);
  const mediasoupLib = window.mediasoupClient;
  if (!mediasoupLib?.Device) return (status.textContent = 'Missing mediasoup client bundle');

  device = new mediasoupLib.Device();
  await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
  currentPresenter = joined.presenterSocketId;
  presenterDisplayName = joined.presenterName || null;
  renderParticipants(joined.participants, currentPresenter);

  const sendInfo = await call('createTransport', { direction: 'send' });
  sendTransport = device.createSendTransport(sendInfo);
  sendTransport.on('connect', ({ dtlsParameters }, cb) => call('connectTransport', { transportId: sendInfo.id, dtlsParameters }).then(cb));
  sendTransport.on('produce', ({ kind, rtpParameters }, cb, eb) => call('produce', { transportId: sendInfo.id, kind, rtpParameters }).then((r) => r.error ? eb(r.error) : cb({ id: r.id })));

  const recvInfo = await call('createTransport', { direction: 'recv' });
  recvTransport = device.createRecvTransport(recvInfo);
  recvTransport.on('connect', ({ dtlsParameters }, cb) => call('connectTransport', { transportId: recvInfo.id, dtlsParameters }).then(cb));

  for (const p of joined.activeProducers || []) await consume(p.id);
  await syncActiveProducers();
})();


async function syncActiveProducers() {
  const res = await call('getActiveProducers');
  for (const p of res.producers || []) {
    if (!activeProducerIds.includes(p.id)) activeProducerIds.push(p.id);
    await consume(p.id);
  }
}

async function consume(producerId) {
  const res = await call('consume', { producerId, transportId: recvTransport.id, rtpCapabilities: device.rtpCapabilities });
  if (res.error) { status.textContent = res.error; return; }
  const consumer = await recvTransport.consume(res);
  console.log('[media] consumer created', { producerId, consumerId: consumer.id, kind: consumer.kind });
  const ms = remoteVideo.srcObject instanceof MediaStream ? remoteVideo.srcObject : new MediaStream();
  const existing = consumer.kind === 'video' ? ms.getVideoTracks() : ms.getAudioTracks();
  existing.forEach((t) => ms.removeTrack(t));
  ms.addTrack(consumer.track);
  await attach(ms, false);
}


async function getLinuxMonitorAudioTrack() {
  console.log('[audio] searching for pcoip-virtual-out.monitor');
  try {
    // Ensure device labels are populated (browsers often hide labels until permission granted).
    const warmup = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    warmup.getTracks().forEach((t) => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    console.log('[audio] available audioinput devices', inputs.map((d) => ({ deviceId: d.deviceId, label: d.label })));

    const preferredPatterns = ['pcoip-virtual-out.monitor', 'pcoipvirtualout.monitor', 'monitor', 'pcoipvirtualin', 'pcoipvirtual'];
    const score = (label) => {
      const l = (label || '').toLowerCase();
      const idx = preferredPatterns.findIndex((p) => l.includes(p));
      return idx === -1 ? 999 : idx;
    };
    const ordered = [...inputs].sort((a, b) => score(a.label) - score(b.label));

    for (const dev of ordered) {
      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: dev.deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          },
          video: false
        });
        const track = audioStream.getAudioTracks()[0] || null;
        if (!track) continue;

        const label = (track.label || dev.label || '').toLowerCase();
        if (label.includes('pcoip-virtual-out.monitor') || label.includes('monitor') || label.includes('pcoipvirtualin') || label.includes('pcoipvirtual')) {
          console.log('[audio] monitor track acquired', { id: track.id, label: track.label || dev.label });
          return track;
        }

        // Not the monitor source we want; close and keep trying.
        audioStream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        console.warn('[audio] failed probing device', dev.label || dev.deviceId, err?.message || err);
      }
    }

    console.warn('[audio] preferred monitor source not found; attempted monitor/pcoip virtual device fallbacks');
    return null;
  } catch (error) {
    console.error('[audio] monitor capture failed', error);
    return null;
  }
}

async function beginSharing() {
  try {
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
    catch { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
    await attach(stream, true);
    const v = stream.getVideoTracks()[0];
    videoProducer = await sendTransport.produce({ track: v });
    // Always use Linux system monitor source for audio in this prototype.
    stream.getAudioTracks().forEach((t) => t.stop());
    let a = await getLinuxMonitorAudioTrack();
    if (!a) {
      status.textContent = 'Unable to capture system audio from pcoip-virtual-out.monitor.';
      throw new Error('System audio source pcoip-virtual-out.monitor not available');
    }
    const audioProducer = await sendTransport.produce({ track: a });
    console.log('[audio] producer started', { producerId: audioProducer.id, trackId: a.id, label: a.label });
    v.onended = () => stopBtn.onclick();
    status.textContent = 'Sharing started with system audio.';
    pendingStart = false;
  } catch (e) {
    pendingStart = false;
    status.textContent = e?.message || 'Unable to start sharing.';
  }
}

startBtn.onclick = async () => {
  if (!sendTransport) return;
  pendingStart = true;
  const result = await call('requestPresenter');
  if (result.pending) return (status.textContent = 'Waiting for current sharer approval...');
  if (!result.approved) { pendingStart = false; return (status.textContent = result.error || 'Cannot start sharing.'); }
  await beginSharing();
};

stopBtn.onclick = () => {
  if (videoProducer) { videoProducer.close(); videoProducer = null; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  remoteVideo.srcObject = null;
  socket.emit('stopSharing');
  status.textContent = 'Sharing stopped.';
};

toggleParticipants.onclick = () => participantsPanel.classList.toggle('hidden');

socket.on('newPresenterStream', async ({ producerId }) => { if (currentPresenter !== socket.id) await consume(producerId); });
socket.on('presenceUpdate', ({ participants, presenterSocketId }) => { currentPresenter = presenterSocketId; renderParticipants(participants, presenterSocketId); });
socket.on('presenterUpdate', ({ presenterSocketId, presenterName: nextPresenterName }) => { currentPresenter = presenterSocketId; presenterDisplayName = nextPresenterName || null; currentSharer.textContent = nextPresenterName || presenterName(); });
socket.on('presenterApprovalNeeded', ({ requesterId, requesterName }) => { pendingRequester = requesterId; approvalText.textContent = `${requesterName} wants to take over sharing.`; approvalBox.classList.remove('hidden'); });
approveBtn.onclick = () => { socket.emit('respondPresenterRequest', { requesterId: pendingRequester, approved: true }); approvalBox.classList.add('hidden'); };
denyBtn.onclick = () => { socket.emit('respondPresenterRequest', { requesterId: pendingRequester, approved: false }); approvalBox.classList.add('hidden'); };
socket.on('presenterRequestResult', async ({ approved }) => {
  if (approved && pendingStart) {
    status.textContent = 'Takeover approved. Starting share...';
    await beginSharing();
    return;
  }
  pendingStart = false;
  status.textContent = approved ? 'Takeover approved.' : 'Takeover denied.';
});
socket.on('forceStopShare', stopBtn.onclick);

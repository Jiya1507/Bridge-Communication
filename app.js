import { LiveSignMLEngine } from './mediapipe-engine.js';
import { TextToSignSynthesizer } from './text-to-sign.js';

class BridgeApplication {
  constructor() {
    this.currentView = 'landing';
    this.localStream = null;
    this.peer = null;
    this.activeCall = null;
    this.dataConnection = null;
    this.roomId = null;
    this.userName = 'Participant';
    this.isAudioActive = true;
    this.isVideoActive = true;
    this.isCaptionsActive = true;
    this.signsData = null;
    this.mlEngine = null;
    this.ttsSynthesizer = null;
    this.speechRecognition = null;
    this.speechSynth = window.speechSynthesis;
    this.rawDetectedSigns = [];
  }

  async init() {
    this.bindDOMEvents();
    this.initSpeechRecognition();
    await this.loadSignsData();
    this.checkURLParams();
    this.restoreA11y();
    this.renderSupportStatus();
  }

  async loadSignsData() {
    try {
      const response = await fetch('./data/signs.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.signsData = await response.json();
      this.renderDictionary();
    } catch (error) {
      console.error('Failed to load signs.json:', error);
      this.signsData = { vocabulary: [] };
      this.showToast('Could not load data/signs.json. Run Bridge through a local web server.', 'error');
    }
  }

  bindDOMEvents() {
    document.querySelectorAll('[data-nav]').forEach((button) => {
      button.addEventListener('click', (event) => this.navigate(event.currentTarget.dataset.nav));
    });

    window.addEventListener('keydown', (event) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (event.key.toUpperCase() === 'M') this.toggleMic();
      if (event.key.toUpperCase() === 'V') this.toggleCamera();
      if (event.key.toUpperCase() === 'C') this.toggleCaptions();
      if (event.key.toUpperCase() === 'H') this.toggleChat();
      if (event.key === 'Escape') this.closeA11yModal();
    });

    this.byId('navA11yBtn')?.addEventListener('click', () => this.openA11yModal());
    this.byId('closeA11yBtn')?.addEventListener('click', () => this.closeA11yModal());
    this.byId('saveA11yBtn')?.addEventListener('click', () => this.saveA11y());

    this.byId('lobbyJoinBtn')?.addEventListener('click', () => this.launchMeeting());
    this.byId('lobbyToggleVideoBtn')?.addEventListener('click', () => this.toggleLobbyVideo());
    this.byId('lobbyToggleAudioBtn')?.addEventListener('click', () => this.toggleLobbyAudio());

    this.byId('dockMicBtn')?.addEventListener('click', () => this.toggleMic());
    this.byId('dockCameraBtn')?.addEventListener('click', () => this.toggleCamera());
    this.byId('dockCaptionsBtn')?.addEventListener('click', () => this.toggleCaptions());
    this.byId('dockSignPanelBtn')?.addEventListener('click', () => this.toggleSignPanel());
    this.byId('dockChatBtn')?.addEventListener('click', () => this.toggleChat());
    this.byId('dockEndCallBtn')?.addEventListener('click', () => this.endCall());
    this.byId('shareLinkBtn')?.addEventListener('click', () => this.copyRoomLink());

    this.byId('speakSentenceBtn')?.addEventListener('click', () => this.speakSentence());
    this.byId('undoSignBtn')?.addEventListener('click', () => this.undoLastSign());
    this.byId('clearSentenceBtn')?.addEventListener('click', () => this.clearSentence());

    this.byId('chatInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.sendChatMessage();
    });
    this.byId('sendChatBtn')?.addEventListener('click', () => this.sendChatMessage());

    this.byId('translateTextBtn')?.addEventListener('click', () => this.handleTextToSign());
    this.byId('textToSignInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.handleTextToSign();
    });
    this.byId('signSpeedSelect')?.addEventListener('change', (event) => {
      this.ttsSynthesizer?.setSpeed(event.target.value);
    });
  }

  byId(id) {
    return document.getElementById(id);
  }

  async navigate(viewName) {
    document.querySelectorAll('.view').forEach((element) => element.classList.add('hidden'));
    const target = this.byId(`view-${viewName}`);
    if (!target) return;

    target.classList.remove('hidden');
    this.currentView = viewName;
    window.scrollTo({ top: 0, behavior: 'auto' });

    if (viewName === 'precall') {
      await this.startLobbyPreview();
    } else if (viewName !== 'meeting') {
      this.mlEngine?.stop();
      this.stopCaptions();
      this.stopMediaTracks();
    }
  }

  showToast(message, type = 'info') {
    const container = this.byId('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    const styles = {
      error: 'bg-red-950/95 border-red-800',
      success: 'bg-emerald-950/95 border-emerald-800',
      warning: 'bg-amber-950/95 border-amber-800',
      info: 'bg-slate-900/95 border-slate-700'
    };
    toast.className = `pointer-events-auto flex items-start gap-3 rounded-xl border p-3 text-xs font-semibold text-white shadow-2xl ${styles[type] ?? styles.info}`;
    const text = document.createElement('span');
    text.className = 'flex-1';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'text-slate-400 hover:text-white';
    close.textContent = '×';
    close.addEventListener('click', () => toast.remove());
    toast.append(text, close);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
  }

  renderSupportStatus() {
    const parts = [];
    parts.push(navigator.mediaDevices?.getUserMedia ? 'Camera API ✓' : 'Camera API ✕');
    parts.push((window.SpeechRecognition || window.webkitSpeechRecognition) ? 'Captions ✓' : 'Captions limited');
    parts.push(window.RTCPeerConnection ? 'WebRTC ✓' : 'WebRTC ✕');
    const element = this.byId('browserSupport');
    if (element) element.textContent = parts.join(' · ');
  }

  async startLobbyPreview() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.showToast('Camera access requires HTTPS or localhost in a supported browser.', 'error');
      return;
    }

    try {
      if (!this.localStream || this.localStream.getTracks().every((track) => track.readyState === 'ended')) {
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      }
      const video = this.byId('lobbyPreviewVideo');
      if (video) video.srcObject = this.localStream;
      this.updateLobbyDiagnostics();
      this.updateLobbyToggleUI();
    } catch (error) {
      console.error('Device permission error:', error);
      if (this.byId('diagCamera')) this.byId('diagCamera').textContent = 'Blocked';
      if (this.byId('diagMic')) this.byId('diagMic').textContent = 'Blocked';
      this.showToast('Allow camera and microphone permission, then reload the page.', 'warning');
    }
  }

  updateLobbyDiagnostics() {
    const camera = this.localStream?.getVideoTracks?.()[0];
    const mic = this.localStream?.getAudioTracks?.()[0];
    if (this.byId('diagCamera')) this.byId('diagCamera').textContent = camera ? (camera.enabled ? 'Active' : 'Off') : 'Not found';
    if (this.byId('diagMic')) this.byId('diagMic').textContent = mic ? (mic.enabled ? 'Active' : 'Muted') : 'Not found';
  }

  updateLobbyToggleUI() {
    const camera = this.localStream?.getVideoTracks?.()[0];
    const mic = this.localStream?.getAudioTracks?.()[0];
    if (this.byId('lobbyToggleVideoBtn')) this.byId('lobbyToggleVideoBtn').textContent = camera?.enabled ? 'Turn Camera Off' : 'Turn Camera On';
    if (this.byId('lobbyToggleAudioBtn')) this.byId('lobbyToggleAudioBtn').textContent = mic?.enabled ? 'Mute Mic' : 'Unmute Mic';
  }

  toggleLobbyVideo() {
    const track = this.localStream?.getVideoTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.isVideoActive = track.enabled;
    this.updateLobbyDiagnostics();
    this.updateLobbyToggleUI();
  }

  toggleLobbyAudio() {
    const track = this.localStream?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.isAudioActive = track.enabled;
    this.updateLobbyDiagnostics();
    this.updateLobbyToggleUI();
  }

  async launchMeeting() {
    this.userName = this.byId('userNameInput')?.value.trim() || 'Participant';
    const targetId = this.byId('targetMeetingIdInput')?.value.trim() || '';
    if (this.byId('localUserName')) this.byId('localUserName').textContent = `${this.userName} (You)`;

    if (!this.localStream) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (error) {
        this.showToast('Camera/microphone access is required for a video call.', 'error');
        return;
      }
    }

    document.querySelectorAll('.view').forEach((element) => element.classList.add('hidden'));
    this.byId('view-meeting')?.classList.remove('hidden');
    this.currentView = 'meeting';

    const localVideo = this.byId('localVideo');
    const canvas = this.byId('landmarkOverlayCanvas');
    if (localVideo) localVideo.srcObject = this.localStream;

    const sizeCanvas = () => {
      if (!localVideo || !canvas) return;
      canvas.width = localVideo.videoWidth || 1280;
      canvas.height = localVideo.videoHeight || 720;
    };
    if (localVideo?.readyState >= 1) sizeCanvas();
    localVideo?.addEventListener('loadedmetadata', sizeCanvas, { once: true });

    this.initPeer(targetId);
    if (localVideo && canvas) this.startMLEngine(localVideo, canvas);
    if (this.isCaptionsActive) this.startCaptions();
  }

  initPeer(targetId) {
    if (!window.Peer) {
      this.showToast('PeerJS failed to load. Check your internet connection.', 'error');
      return;
    }

    this.peer?.destroy?.();
    const isHost = !targetId;
    const peerId = isHost
      ? `host-${crypto.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10)}`
      : `guest-${crypto.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10)}`;

    this.roomId = isHost ? peerId : targetId;
    if (this.byId('callRoomId')) this.byId('callRoomId').textContent = this.roomId;

    this.peer = new window.Peer(peerId, {
      host: '0.peerjs.com',
      port: 443,
      path: '/',
      secure: true,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    });

    this.peer.on('open', (id) => {
      this.showToast(`Peer ready: ${id}`, 'success');
      if (!isHost && targetId) {
        const call = this.peer.call(targetId, this.localStream, { metadata: { name: this.userName } });
        this.activeCall = call;
        this.bindCallEvents(call);

        const connection = this.peer.connect(targetId, { reliable: true, metadata: { name: this.userName } });
        this.bindDataConnection(connection);
      }
    });

    this.peer.on('call', (call) => {
      this.activeCall = call;
      call.answer(this.localStream);
      this.bindCallEvents(call);
    });

    this.peer.on('connection', (connection) => this.bindDataConnection(connection));
    this.peer.on('error', (error) => {
      console.error('PeerJS error:', error);
      const friendly = error?.type === 'peer-unavailable'
        ? 'Host not found. Confirm the meeting link/ID and that the host is still connected.'
        : `Connection error: ${error?.type || 'unknown'}`;
      this.showToast(friendly, 'error');
    });
  }

  bindCallEvents(call) {
    if (!call) return;
    call.on('stream', (remoteStream) => {
      const remoteVideo = this.byId('remoteVideo');
      if (remoteVideo) remoteVideo.srcObject = remoteStream;
      this.byId('remotePlaceholder')?.classList.add('hidden');
      const remoteName = call.metadata?.name || 'Remote participant';
      if (this.byId('remoteUserName')) this.byId('remoteUserName').textContent = remoteName;
      this.showToast(`${remoteName} connected`, 'success');
    });

    call.on('close', () => {
      this.byId('remotePlaceholder')?.classList.remove('hidden');
      this.showToast('Participant disconnected');
    });

    call.on('error', (error) => {
      console.error('Call error:', error);
      this.showToast('Media call error', 'error');
    });
  }

  bindDataConnection(connection) {
    if (!connection) return;
    this.dataConnection = connection;

    connection.on('open', () => {
      this.appendSystemMessage('Chat channel connected.');
    });

    connection.on('data', (payload) => {
      if (payload?.type === 'chat' && typeof payload.text === 'string') {
        this.appendChatMessage(payload.name || 'Participant', payload.text, false);
      }
    });

    connection.on('close', () => this.appendSystemMessage('Chat channel disconnected.'));
    connection.on('error', () => this.appendSystemMessage('Chat connection error.'));
  }

  async startMLEngine(video, canvas) {
    const badge = this.byId('engineStatusBadge');
    this.mlEngine?.stop();
    this.mlEngine = new LiveSignMLEngine({
      videoElement: video,
      canvasElement: canvas,
      onStateChangeCallback: (state) => {
        if (badge && state.status) badge.textContent = state.status;
      },
      onPredictionCallback: (result) => {
        if (this.byId('signConfidenceScore')) {
          this.byId('signConfidenceScore').textContent = `Confidence: ${Math.round(result.confidence * 100)}%`;
        }
        if (result.isStable && result.predictedClass !== 'NO_SIGN') {
          this.registerDetectedSign(result.predictedClass, result.confidence);
        }
      }
    });

    const ready = await this.mlEngine.initialize();
    if (ready) this.mlEngine.start();
  }

  registerDetectedSign(signLabel, confidence) {
    const previous = this.rawDetectedSigns.at(-1);
    if (previous?.label === signLabel && Date.now() - previous.timestamp < 1800) return;
    this.rawDetectedSigns.push({
      label: signLabel,
      confidence: Math.round(confidence * 100),
      timestamp: Date.now()
    });
    this.updateSentenceUI();
  }

  undoLastSign() {
    this.rawDetectedSigns.pop();
    this.updateSentenceUI();
  }

  clearSentence() {
    this.rawDetectedSigns = [];
    this.updateSentenceUI();
  }

  updateSentenceUI() {
    const sequence = this.byId('detectedSignSequence');
    const output = this.byId('sentenceOutputArea');
    if (!sequence || !output) return;

    sequence.replaceChildren();
    if (!this.rawDetectedSigns.length) {
      const empty = document.createElement('span');
      empty.className = 'text-slate-500 italic';
      empty.textContent = 'No gestures registered';
      sequence.appendChild(empty);
      output.value = '';
      return;
    }

    for (const sign of this.rawDetectedSigns) {
      const badge = document.createElement('span');
      badge.className = 'rounded border border-indigo-700 bg-indigo-950 px-2 py-0.5 text-indigo-300';
      badge.textContent = `${sign.label} (${sign.confidence}%)`;
      sequence.appendChild(badge);
    }

    const labels = this.rawDetectedSigns.map((sign) => sign.label);
    const phraseMap = new Map([
      ['HELLO', 'Hello.'],
      ['THANK_YOU', 'Thank you.'],
      ['HELP', 'I need help.'],
      ['WATER', 'I need water.'],
      ['YES', 'Yes.'],
      ['NO', 'No.'],
      ['HELP WATER', 'I need water, please.'],
      ['WATER THANK_YOU', 'Water, thank you.']
    ]);
    const raw = labels.join(' ');
    output.value = phraseMap.get(raw) || `${labels.map((label) => label.replaceAll('_', ' ').toLowerCase()).join(' ')}.`;
  }

  speakSentence() {
    const text = this.byId('sentenceOutputArea')?.value.trim();
    if (!text || !this.speechSynth) return;
    this.speechSynth.cancel();
    this.speechSynth.speak(new SpeechSynthesisUtterance(text));
    this.showToast('Speaking the constructed sentence…');
  }

  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    this.speechRecognition = new SpeechRecognition();
    this.speechRecognition.continuous = true;
    this.speechRecognition.interimResults = true;
    this.speechRecognition.lang = 'en-IN';
    this.speechRecognition.onresult = (event) => {
      let text = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        text += event.results[index][0].transcript;
      }
      if (text && this.byId('captionStreamText')) this.byId('captionStreamText').textContent = text;
    };
    this.speechRecognition.onerror = (event) => {
      if (!['no-speech', 'aborted'].includes(event.error)) console.warn('Speech recognition:', event.error);
    };
    this.speechRecognition.onend = () => {
      if (this.isCaptionsActive && this.currentView === 'meeting') {
        setTimeout(() => {
          try { this.speechRecognition.start(); } catch (_) {}
        }, 400);
      }
    };
  }

  startCaptions() {
    this.byId('liveCaptionsOverlay')?.classList.remove('hidden');
    if (!this.speechRecognition) {
      if (this.byId('captionStreamText')) this.byId('captionStreamText').textContent = 'Speech recognition is not supported in this browser.';
      return;
    }
    try { this.speechRecognition.start(); } catch (_) {}
  }

  stopCaptions() {
    try { this.speechRecognition?.stop(); } catch (_) {}
    this.byId('liveCaptionsOverlay')?.classList.add('hidden');
  }

  toggleCaptions() {
    this.isCaptionsActive = !this.isCaptionsActive;
    this.byId('dockCaptionsBtn')?.classList.toggle('bg-indigo-600', this.isCaptionsActive);
    this.byId('dockCaptionsBtn')?.classList.toggle('bg-slate-800', !this.isCaptionsActive);
    if (this.isCaptionsActive) this.startCaptions();
    else this.stopCaptions();
  }

  toggleChat() {
    this.byId('chatPanel')?.classList.toggle('hidden');
  }

  sendChatMessage() {
    const input = this.byId('chatInput');
    const text = input?.value.trim();
    if (!text) return;

    this.appendChatMessage('You', text, true);
    if (this.dataConnection?.open) {
      this.dataConnection.send({ type: 'chat', name: this.userName, text });
    } else {
      this.appendSystemMessage('Message kept locally: the peer chat channel is not connected yet.');
    }
    input.value = '';
  }

  appendChatMessage(name, text, isSelf) {
    const box = this.byId('chatMessages');
    if (!box) return;
    const wrapper = document.createElement('div');
    wrapper.className = `max-w-[88%] rounded-xl border p-2.5 text-xs ${isSelf ? 'ml-auto border-indigo-800 bg-indigo-950/60' : 'mr-auto border-slate-700 bg-slate-800'}`;
    const author = document.createElement('span');
    author.className = 'mb-1 block font-bold text-indigo-300';
    author.textContent = name;
    const body = document.createElement('p');
    body.className = 'break-words text-slate-100';
    body.textContent = text;
    wrapper.append(author, body);
    box.appendChild(wrapper);
    box.scrollTop = box.scrollHeight;
  }

  appendSystemMessage(text) {
    const box = this.byId('chatMessages');
    if (!box) return;
    const message = document.createElement('p');
    message.className = 'text-center text-[10px] text-slate-500';
    message.textContent = text;
    box.appendChild(message);
  }

  handleTextToSign() {
    const input = this.byId('textToSignInput')?.value ?? '';
    const video = this.byId('signVideoPlayer');
    const status = this.byId('signPlaybackStatus');
    const sequence = this.byId('translatedSignSequence');
    if (!this.signsData || !video) return;

    if (!this.ttsSynthesizer) {
      this.ttsSynthesizer = new TextToSignSynthesizer(this.signsData, video, status);
    }
    this.ttsSynthesizer.setSpeed(this.byId('signSpeedSelect')?.value || 1);
    const queue = this.ttsSynthesizer.translateText(input);

    if (sequence) {
      sequence.replaceChildren();
      queue.forEach((token, index) => {
        if (index > 0) {
          const arrow = document.createElement('span');
          arrow.className = 'self-center text-slate-600';
          arrow.textContent = '→';
          sequence.appendChild(arrow);
        }
        const badge = document.createElement('span');
        badge.className = token.found
          ? 'rounded border border-indigo-700 bg-indigo-950 px-2.5 py-1 font-bold text-indigo-300'
          : 'rounded border border-amber-800 bg-amber-950 px-2.5 py-1 font-bold text-amber-300';
        badge.textContent = token.found ? token.gloss : `${token.gloss} · unmapped`;
        sequence.appendChild(badge);
      });
    }

    this.ttsSynthesizer.playQueue();
  }

  renderDictionary() {
    const grid = this.byId('signsDictionaryGrid');
    if (!grid || !this.signsData?.vocabulary) return;
    grid.replaceChildren();

    for (const sign of this.signsData.vocabulary) {
      const card = document.createElement('article');
      card.className = 'flex flex-col justify-between rounded-2xl border border-slate-800 bg-slate-900 p-5';
      const content = document.createElement('div');
      const category = document.createElement('span');
      category.className = 'rounded border border-indigo-800 bg-indigo-950 px-2 py-0.5 text-[10px] font-bold text-indigo-300';
      category.textContent = sign.category;
      const heading = document.createElement('h3');
      heading.className = 'mt-3 text-lg font-bold text-white';
      heading.textContent = sign.gloss.replaceAll('_', ' ');
      const description = document.createElement('p');
      description.className = 'mt-1 text-xs leading-5 text-slate-400';
      description.textContent = sign.description;
      content.append(category, heading, description);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mt-4 rounded-lg bg-slate-800 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700';
      button.textContent = sign.demoVideo ? 'Preview demo clip' : 'Preview sign video';
      button.addEventListener('click', () => this.previewSignVideo(sign.videoUrl, sign.gloss, sign.demoVideo));
      card.append(content, button);
      grid.appendChild(card);
    }
  }

  previewSignVideo(url, gloss = 'SIGN', demoVideo = false) {
    const video = this.byId('signVideoPlayer');
    const status = this.byId('signPlaybackStatus');
    if (!video) return;
    video.src = url;
    if (status) status.textContent = `${gloss}${demoVideo ? ' · DEMO clip' : ''}`;
    video.play().catch(() => this.showToast('Press Play to preview the video.'));
    this.navigate('learn');
  }

  toggleMic() {
    const track = this.localStream?.getAudioTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.isAudioActive = track.enabled;
    this.byId('dockMicBtn')?.classList.toggle('ring-2', !track.enabled);
    this.byId('dockMicBtn')?.classList.toggle('ring-red-500', !track.enabled);
    this.showToast(`Microphone ${track.enabled ? 'unmuted' : 'muted'}`);
  }

  toggleCamera() {
    const track = this.localStream?.getVideoTracks?.()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    this.isVideoActive = track.enabled;
    this.byId('dockCameraBtn')?.classList.toggle('ring-2', !track.enabled);
    this.byId('dockCameraBtn')?.classList.toggle('ring-red-500', !track.enabled);
    this.showToast(`Camera ${track.enabled ? 'on' : 'off'}`);
  }

  toggleSignPanel() {
    this.byId('signLanguagePanel')?.classList.toggle('hidden');
  }

  endCall() {
    this.mlEngine?.stop();
    this.stopCaptions();
    this.activeCall?.close?.();
    this.dataConnection?.close?.();
    this.peer?.destroy?.();
    this.peer = null;
    this.activeCall = null;
    this.dataConnection = null;
    this.stopMediaTracks();
    this.clearSentence();
    this.byId('remotePlaceholder')?.classList.remove('hidden');
    this.navigate('landing');
    this.showToast('Call ended');
  }

  stopMediaTracks() {
    this.localStream?.getTracks?.().forEach((track) => track.stop());
    this.localStream = null;
    const lobby = this.byId('lobbyPreviewVideo');
    const local = this.byId('localVideo');
    if (lobby) lobby.srcObject = null;
    if (local) local.srcObject = null;
  }

  async copyRoomLink() {
    if (!this.roomId) return;
    const url = `${window.location.origin}${window.location.pathname}?call=${encodeURIComponent(this.roomId)}`;
    try {
      await navigator.clipboard.writeText(url);
      this.showToast('Meeting link copied.', 'success');
    } catch (_) {
      window.prompt('Copy this meeting link:', url);
    }
  }

  checkURLParams() {
    const params = new URLSearchParams(window.location.search);
    const callId = params.get('call');
    if (callId) {
      const input = this.byId('targetMeetingIdInput');
      if (input) input.value = callId;
      this.navigate('precall');
    }
  }

  openA11yModal() {
    this.byId('a11yModal')?.classList.remove('hidden');
  }

  closeA11yModal() {
    this.byId('a11yModal')?.classList.add('hidden');
  }

  saveA11y() {
    const highContrast = Boolean(this.byId('highContrastToggle')?.checked);
    const largerText = Boolean(this.byId('largerTextToggle')?.checked);
    document.body.classList.toggle('high-contrast', highContrast);
    document.documentElement.classList.toggle('larger-text', largerText);
    localStorage.setItem('bridge-a11y', JSON.stringify({ highContrast, largerText }));
    this.closeA11yModal();
    this.showToast('Accessibility preferences saved.', 'success');
  }

  restoreA11y() {
    try {
      const saved = JSON.parse(localStorage.getItem('bridge-a11y') || '{}');
      if (this.byId('highContrastToggle')) this.byId('highContrastToggle').checked = Boolean(saved.highContrast);
      if (this.byId('largerTextToggle')) this.byId('largerTextToggle').checked = Boolean(saved.largerText);
      document.body.classList.toggle('high-contrast', Boolean(saved.highContrast));
      document.documentElement.classList.toggle('larger-text', Boolean(saved.largerText));
    } catch (_) {}
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.bridgeApp = new BridgeApplication();
  window.bridgeApp.init();
});

// admin-live.js (v6 — Pro Ultra: force H.264 for WebRTC, MediaMTX-compatible HLS)
// Akimark Live Admin Control Center

(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // CONFIG & AUTH
  // ════════════════════════════════════════════════════════════
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  const TOKEN = localStorage.getItem('akmark_admin_token');
  if (!TOKEN) { window.location.href = 'admin-login.html'; return; }

  const admin = JSON.parse(localStorage.getItem('akmark_admin') || '{}');
  const adminNameBadge = document.getElementById('adminNameBadge');
  if (adminNameBadge && admin.full_name) adminNameBadge.textContent = 'Hi, ' + admin.full_name;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.error('❌ Supabase config missing'); return; }

  let supabase;
  try { supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
  catch (e) { console.error('❌ Supabase init failed:', e); return; }

  const API_URL = `${SUPABASE_URL}/functions/v1/live-start-api`;
  const STREAM_BASE = 'https://akimark.mw';
  const WHIP_PATH = '/webrtc';
  const HLS_PATH = '/hls';

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let allStreams = [];
  let currentCameraStream = null;
  let currentPeerConnection = null;
  let liveRefreshTimer = null;
  let statsPollTimer = null;
  let activeCameraLiveId = null;
  let selectedMp4File = null;

  // ════════════════════════════════════════════════════════════
  // DOM
  // ════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const statTotal = $('statTotal');
  const statLive = $('statLive');
  const statScheduled = $('statScheduled');
  const statEnded = $('statEnded');
  const streamList = $('streamList');
  const refreshBtn = $('refreshBtn');
  const toastContainer = $('toastContainer');
  const modalOverlay = $('modalOverlay');
  const modalTitle = $('modalTitle');
  const modalMessage = $('modalMessage');
  const modalCancel = $('modalCancel');
  const modalConfirm = $('modalConfirm');
  const loadingOverlay = $('loadingOverlay');
  const loadingText = $('loadingText');
  const uploadZone = $('uploadZone');
  const mp4FileInput = $('mp4File');
  const uploadText = $('uploadText');
  const uploadSub = $('uploadSub');
  const uploadIcon = $('uploadIcon');
  const uploadProgress = $('uploadProgress');
  const uploadBarFill = $('uploadBarFill');
  const uploadPct = $('uploadPct');
  const mp4Title = $('mp4Title');
  const startMp4Btn = $('startMp4Btn');
  const camTitle = $('camTitle');
  const startCamBtn = $('startCamBtn');
  const cameraPreviewWrap = $('cameraPreviewWrap');
  const cameraPreview = $('cameraPreview');
  const camStatsCard = $('camStatsCard');
  const camViews = $('camViews');
  const camLikes = $('camLikes');
  const camComments = $('camComments');
  const camCommentList = $('camCommentList');

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════
  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    const icon = type === 'success' ? 'bi-check-circle-fill' : 'bi-x-circle-fill';
    toast.innerHTML = `<i class="bi ${icon} toast-icon"></i><span class="toast-msg">${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => { toast.style.animation = 'slideOutRight 0.3s ease'; setTimeout(() => toast.remove(), 300); }, 3500);
  }
  function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.className = 'status-text ' + state;
    statusText.textContent = text;
  }
  function showLoading(text) { loadingText.textContent = text || 'Processing…'; loadingOverlay.classList.add('visible'); }
  function hideLoading() { loadingOverlay.classList.remove('visible'); }

  function confirmModal(title, message, confirmText = 'Confirm') {
    return new Promise((resolve) => {
      modalTitle.textContent = title;
      modalMessage.textContent = message;
      modalConfirm.textContent = confirmText;
      modalOverlay.classList.add('visible');
      const close = (result) => {
        modalOverlay.classList.remove('visible');
        modalCancel.removeEventListener('click', onCancel);
        modalConfirm.removeEventListener('click', onConfirm);
        resolve(result);
      };
      const onCancel = () => close(false);
      const onConfirm = () => close(true);
      modalCancel.addEventListener('click', onCancel);
      modalConfirm.addEventListener('click', onConfirm);
    });
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function formatMalawiTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const malawi = new Date(d.getTime() + 2 * 3600 * 1000);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${String(malawi.getUTCDate()).padStart(2,'0')} ${months[malawi.getUTCMonth()]} ${malawi.getUTCFullYear()} • ${String(malawi.getUTCHours()).padStart(2,'0')}:${String(malawi.getUTCMinutes()).padStart(2,'0')} CAT`;
    } catch (e) { return '—'; }
  }
  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B','KB','MB','GB'];
    let i = 0; let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${units[i]}`;
  }

  // ════════════════════════════════════════════════════════════
  // DIAGNOSTIC MODAL
  // ════════════════════════════════════════════════════════════
  function showDiagnostic(title, lines) {
    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;`;
    const box = document.createElement('div');
    box.style.cssText = `background:#111827;border:1px solid #1F2937;border-radius:14px;padding:20px;width:100%;max-width:560px;max-height:85vh;overflow-y:auto;color:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;`;
    box.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-weight:800;font-size:1rem;">${escapeHtml(title)}</div>
        <button id="diagClose" style="background:none;border:none;color:#9CA3AF;font-size:1.2rem;cursor:pointer;">✕</button>
      </div>
      <div style="background:#0B0F19;border-radius:10px;padding:12px;font-family:monospace;font-size:0.7rem;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:#F9FAFB;max-height:60vh;overflow-y:auto;">${lines.map((l) => escapeHtml(String(l))).join('\n')}</div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button id="diagCopy" style="flex:1;padding:12px;background:#1F2937;color:#F9FAFB;border:1px solid #1F2937;border-radius:10px;font-weight:700;font-size:0.8rem;cursor:pointer;">📋 Copy All</button>
        <button id="diagOk" style="flex:1;padding:12px;background:#E11D48;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:0.8rem;cursor:pointer;">OK</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    box.querySelector('#diagClose').onclick = close;
    box.querySelector('#diagOk').onclick = close;
    box.querySelector('#diagCopy').onclick = () => {
      const text = lines.join('\n');
      navigator.clipboard?.writeText(text).then(() => {
        box.querySelector('#diagCopy').textContent = '✅ Copied!';
        setTimeout(() => { box.querySelector('#diagCopy').textContent = '📋 Copy All'; }, 1500);
      });
    };
  }

  function buildDiagnostics(context, err, extra = {}) {
    const lines = [`Context: ${context}`, `Time: ${new Date().toISOString()}`, ''];
    if (err) {
      lines.push(`Error: ${err.message || String(err)}`);
      if (err.status) lines.push(`HTTP Status: ${err.status}`);
      if (err.responseText) lines.push(`Response Body: ${String(err.responseText).slice(0, 500)}`);
    }
    Object.keys(extra).forEach((k) => {
      const v = extra[k];
      if (v === undefined || v === null) return;
      lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    });
    return lines;
  }

  // ════════════════════════════════════════════════════════════
  // API WRAPPER
  // ════════════════════════════════════════════════════════════
  async function apiCall(action, payload = {}) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `API error ${res.status}`);
      e.status = res.status;
      e.response = data;
      throw e;
    }
    return data;
  }

  // ════════════════════════════════════════════════════════════
  // 🔑 FORCE H.264 CODEC for WebRTC (MediaMTX fmp4 requirement)
  // ════════════════════════════════════════════════════════════
  function enforceH264Codec(pc) {
    try {
      if (!pc.getTransceivers || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) {
        console.warn('Browser doesn\'t support codec preferences');
        return false;
      }
      const transceivers = pc.getTransceivers();
      let applied = false;
      for (const transceiver of transceivers) {
        const kind = transceiver.sender?.track?.kind || transceiver.receiver?.track?.kind;
        if (kind === 'video' && typeof transceiver.setCodecPreferences === 'function') {
          const caps = RTCRtpSender.getCapabilities('video');
          if (!caps || !caps.codecs) continue;
          // Filter only H.264 variants
          const h264 = caps.codecs.filter((c) => (c.mimeType || '').toLowerCase() === 'video/h264');
          if (h264.length > 0) {
            transceiver.setCodecPreferences(h264);
            console.log('✅ H.264 codecs enforced:', h264.map(c => c.sdpFmtpLine || c.mimeType));
            applied = true;
          } else {
            console.warn('⚠️ No H.264 codec available in this browser');
          }
        }
      }
      return applied;
    } catch (e) {
      console.warn('Codec preference error:', e);
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  // HEALTH CHECK
  // ════════════════════════════════════════════════════════════
  async function checkHealth() {
    setStatus('checking', 'Checking…');
    try {
      const data = await apiCall('health');
      if (data.success) setStatus('ok', 'Online');
      else setStatus('error', 'Linode offline');
    } catch (err) {
      console.error('Health error:', err);
      setStatus('error', 'Unreachable');
      if (window._manualRefresh) {
        window._manualRefresh = false;
        showDiagnostic('Linode API Unreachable', buildDiagnostics('Health check', err, { Action: 'health', 'API URL': API_URL }));
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // LOAD STREAMS
  // ════════════════════════════════════════════════════════════
  async function loadStreams() {
    try {
      const data = await apiCall('list');
      allStreams = data.streams || [];
      renderStats();
      renderStreams();
    } catch (err) {
      console.error('Load streams error:', err);
      streamList.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="bi bi-exclamation-triangle-fill"></i></div><h4>Failed to load</h4><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  function renderStats() {
    const total = allStreams.length;
    const live = allStreams.filter(s => s.status === 'live').length;
    const scheduled = allStreams.filter(s => s.status === 'scheduled').length;
    const ended = allStreams.filter(s => s.status === 'ended').length;
    statTotal.textContent = total;
    statLive.textContent = live;
    statScheduled.textContent = scheduled;
    statEnded.textContent = ended;
    document.title = live > 0 ? `🔴 LIVE (${live}) — Akimark Live` : 'LIVE — Akimark Admin';
  }

  function renderStreams() {
    if (allStreams.length === 0) {
      streamList.innerHTML = `<div class="empty-state"><div class="empty-icon"><i class="bi bi-broadcast"></i></div><h4>No streams yet</h4><p>Start your first MP4 or Camera live stream from the tabs above.</p></div>`;
      return;
    }
    streamList.innerHTML = allStreams.map((s) => {
      const isLive = s.status === 'live';
      const isEnded = s.status === 'ended';
      const isScheduled = s.status === 'scheduled';
      const isMp4 = s.mode === 'mp4' || !s.mode;
      const statusClass = isLive ? 'live' : (isEnded ? 'ended' : 'scheduled');
      const statusText = isLive ? 'LIVE' : (isEnded ? 'ENDED' : (isScheduled ? 'SCHEDULED' : String(s.status || '').toUpperCase()));
      const modeClass = isMp4 ? 'mp4' : 'camera';
      const modeText = isMp4 ? '🎬 MP4' : '📷 Camera';
      const hlsUrl = s.hls_url || '';
      const isFree = s.is_free !== false;
      const priceLabel = isFree ? 'Free' : `MWK ${Number(s.price || 0).toLocaleString()}`;
      const priceClass = isFree ? 'free' : 'paid';
      const views = s.views_count || 0;
      const likes = s.likes_count || 0;
      const comments = s.comments_count || 0;

      return `
        <div class="stream-card ${isLive ? 'live' : ''}">
          <div class="stream-header">
            <div class="stream-info">
              <div class="stream-title">${escapeHtml(s.title || 'Untitled')}</div>
              <div class="stream-meta">
                <span class="stream-badge ${statusClass}">${statusText}</span>
                <span class="stream-badge ${modeClass}">${modeText}</span>
                <span class="stream-badge ${priceClass}">${priceLabel}</span>
                <span>${formatMalawiTime(s.actual_start || s.created_at)}</span>
              </div>
            </div>
          </div>
          <div class="stream-quickstats">
            <span><i class="bi bi-eye-fill"></i> ${views}</span>
            <span><i class="bi bi-heart-fill"></i> ${likes}</span>
            <span><i class="bi bi-chat-dots-fill"></i> ${comments}</span>
          </div>
          ${isLive && hlsUrl ? `
            <div class="live-preview active">
              <video id="preview-${s.id}" controls playsinline muted></video>
              <div class="live-preview-info">
                <div class="row"><span class="key">HLS URL</span><span class="val">${escapeHtml(hlsUrl).slice(0, 45)}…</span></div>
                <div class="row"><span class="key">Stream Key</span><span class="val">${escapeHtml(s.stream_key || '—').slice(0, 20)}…</span></div>
                <div class="row"><span class="key">Started</span><span class="val">${formatMalawiTime(s.actual_start)}</span></div>
              </div>
            </div>` : ''}
          <div class="stream-actions">
            ${isLive ? `<button class="btn-custom btn-danger-custom" onclick="window._adminStopStream('${s.id}')"><i class="bi bi-stop-circle-fill"></i> STOP</button>` : ''}
            ${isEnded && s.video_key ? `<button class="btn-custom btn-live" onclick="window._adminRestartStream('${s.id}')"><i class="bi bi-arrow-clockwise"></i> RESTART</button>` : ''}
          </div>
        </div>`;
    }).join('');

    if (window.Hls && window.Hls.isSupported()) {
      allStreams.forEach((s) => {
        if (s.status !== 'live' || !s.hls_url) return;
        const videoEl = document.getElementById(`preview-${s.id}`);
        if (!videoEl) return;
        try {
          const hls = new window.Hls({ lowLatencyMode: false, xhrSetup: (xhr) => { xhr.withCredentials = true; } });
          hls.loadSource(s.hls_url);
          hls.attachMedia(videoEl);
        } catch (e) { console.warn('HLS preview error:', e); }
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // PRICE TOGGLE
  // ════════════════════════════════════════════════════════════
  function setupPriceToggle(toggleId, priceInputId) {
    const toggle = document.getElementById(toggleId);
    const priceInput = document.getElementById(priceInputId);
    if (!toggle || !priceInput) return;
    toggle.querySelectorAll('.price-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        toggle.querySelectorAll('.price-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const isFree = btn.dataset.free === '1';
        priceInput.style.display = isFree ? 'none' : 'block';
        if (isFree) priceInput.value = '';
      });
    });
  }
  function getPriceValues(toggleId, priceInputId) {
    const toggle = document.getElementById(toggleId);
    const priceInput = document.getElementById(priceInputId);
    const activeBtn = toggle?.querySelector('.price-btn.active');
    const isFree = activeBtn ? activeBtn.dataset.free === '1' : true;
    const price = isFree ? 0 : Number(priceInput?.value || 0);
    return { isFree, price };
  }

  // ════════════════════════════════════════════════════════════
  // UPLOAD VIDEO
  // ════════════════════════════════════════════════════════════
  function updateUploadZoneUI(file) {
    if (!file) {
      uploadZone.classList.remove('has-file');
      uploadText.textContent = 'Tap to select video';
      uploadSub.textContent = 'MP4 recommended • up to 2GB';
      uploadIcon.className = 'bi bi-cloud-arrow-up-fill';
      return;
    }
    uploadZone.classList.add('has-file');
    uploadText.textContent = file.name;
    uploadSub.textContent = formatBytes(file.size);
    uploadIcon.className = 'bi bi-check-circle-fill';
  }

  function uploadVideoWithProgress(file, onProgress) {
    return new Promise(async (resolve, reject) => {
      try {
        const { upload_url, video_key } = await apiCall('upload_url', { filename: file.name, content_type: file.type || 'video/mp4' });
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', upload_url, true);
        xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(video_key);
          else { const e = new Error(`Upload failed: HTTP ${xhr.status}`); e.status = xhr.status; e.responseText = xhr.responseText?.slice(0, 500); reject(e); }
        };
        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.send(file);
      } catch (err) { reject(err); }
    });
  }

  // ════════════════════════════════════════════════════════════
  // START MP4 → LIVE
  // ════════════════════════════════════════════════════════════
  async function startMp4Stream() {
    if (!selectedMp4File) return showToast('Please select a video file first', 'error');
    const title = mp4Title.value.trim() || selectedMp4File.name.replace(/\.[^.]+$/, '') || 'Live Stream';
    const { isFree, price } = getPriceValues('mp4PriceToggle', 'mp4Price');
    if (!isFree && (!price || price <= 0)) return showToast('Please enter a valid price or select Free', 'error');

    const confirmed = await confirmModal('🎬 Go Live', `Upload and start live with "${title}"?${isFree ? ' (Free)' : ` (MWK ${price.toLocaleString()})`}`, 'GO LIVE');
    if (!confirmed) return;

    showLoading('Uploading video…');
    uploadProgress.style.display = 'block';
    uploadBarFill.style.width = '0%';
    uploadPct.textContent = '0%';

    let videoKey = null;
    let created = null;
    try {
      videoKey = await uploadVideoWithProgress(selectedMp4File, (pct) => {
        uploadBarFill.style.width = pct + '%';
        uploadPct.textContent = pct + '%';
        if (pct === 100) showLoading('Processing on server…');
      });
      uploadBarFill.style.width = '100%';
      uploadPct.textContent = '100%';

      showLoading('Creating stream…');
      const insertRes = await supabase.from('live_videos').insert({
        title, status: 'scheduled', mode: 'mp4', admin_id: admin.admin_id,
        broadcaster_name: admin.full_name || null, video_key: videoKey,
        is_free: isFree, price: isFree ? 0 : price,
      }).select().single();
      if (insertRes.error || !insertRes.data) throw new Error(insertRes.error?.message || 'Failed to create stream row');
      created = insertRes.data;

      showLoading('Starting stream on server…');
      const startResult = await apiCall('start', { live_id: created.id, video_key: videoKey });

      const streamName = startResult.stream_name;
      const hlsUrl = `${STREAM_BASE}${HLS_PATH}/${streamName}/index.m3u8`;
      const webrtcUrl = `${STREAM_BASE}${WHIP_PATH}/${streamName}`;
      await supabase.from('live_videos').update({ hls_url: hlsUrl, webrtc_url: webrtcUrl }).eq('id', created.id);

      hideLoading();
      uploadProgress.style.display = 'none';
      showToast('✅ Stream started successfully!', 'success');

      selectedMp4File = null;
      mp4FileInput.value = '';
      updateUploadZoneUI(null);
      mp4Title.value = '';
      switchTab('streams');
      await loadStreams();
    } catch (err) {
      console.error('Start MP4 error:', err);
      hideLoading();
      uploadProgress.style.display = 'none';
      showDiagnostic('MP4 → Live failed', buildDiagnostics('MP4 upload/start', err));
      showToast('Failed: ' + (err.message || err), 'error');
    }
  }

  // ════════════════════════════════════════════════════════════
  // START CAMERA LIVE (with H.264 enforcement)
  // ════════════════════════════════════════════════════════════
  async function startCameraStream() {
    const title = camTitle.value.trim() || 'Camera Live';
    const { isFree, price } = getPriceValues('camPriceToggle', 'camPrice');
    if (!isFree && (!price || price <= 0)) return showToast('Please enter a valid price or select Free', 'error');

    const confirmed = await confirmModal('📷 Open Camera', `Go live with your camera as "${title}"?${isFree ? ' (Free)' : ` (MWK ${price.toLocaleString()})`}`, 'OPEN CAMERA');
    if (!confirmed) return;

    showLoading('Opening camera…');
    let created = null;
    let streamName = null;
    let whipUrl = null;

    try {
      // 1. Request camera — prefer 720p, H.264-friendly
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
          facingMode: 'user',
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000,
        },
      });
      currentCameraStream = mediaStream;

      // Check tracks
      const vTracks = mediaStream.getVideoTracks();
      const aTracks = mediaStream.getAudioTracks();
      console.log('📷 Tracks:', {
        video: vTracks.map(t => ({ label: t.label, settings: t.getSettings() })),
        audio: aTracks.map(t => ({ label: t.label, settings: t.getSettings() })),
      });

      if (vTracks.length === 0) throw new Error('No video track from camera');
      if (aTracks.length === 0) console.warn('⚠️ No audio track — video only');

      // 2. Attach preview
      cameraPreview.srcObject = mediaStream;
      cameraPreviewWrap.classList.add('active');

      // 3. Create live_videos row
      const insertRes = await supabase.from('live_videos').insert({
        title, status: 'scheduled', mode: 'camera',
        admin_id: admin.admin_id,
        broadcaster_name: admin.full_name || null,
        is_free: isFree, price: isFree ? 0 : price,
      }).select().single();
      if (insertRes.error || !insertRes.data) throw new Error(insertRes.error?.message || 'Failed to create stream row');
      created = insertRes.data;
      activeCameraLiveId = created.id;
      streamName = created.stream_key;

      // 4. Create PeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
        bundlePolicy: 'max-bundle',
      });
      currentPeerConnection = pc;
      mediaStream.getTracks().forEach((t) => pc.addTrack(t, mediaStream));

      // ═══════════════════════════════════════════════════════
      // 🔑 FORCE H.264 — MediaMTX fmp4 requires H.264 for HLS
      // ═══════════════════════════════════════════════════════
      const h264Applied = enforceH264Codec(pc);
      if (h264Applied) {
        showToast('✅ H.264 codec enforced for MediaMTX', 'success');
      } else {
        console.warn('⚠️ H.264 not enforced — stream may only have audio in HLS');
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      showLoading('Connecting to server…');

      // 5. Send WHIP offer
      whipUrl = `${STREAM_BASE}${WHIP_PATH}/${streamName}/whip`;
      console.log('🔗 WHIP URL:', whipUrl);
      console.log('📋 SDP (first 500):', offer.sdp.slice(0, 500));

      const whipRes = await fetch(whipUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });

      if (!whipRes.ok) {
        const bodyText = await whipRes.text().catch(() => '');
        const e = new Error(`WHIP connection failed: HTTP ${whipRes.status}`);
        e.status = whipRes.status;
        e.responseText = bodyText.slice(0, 500);
        throw e;
      }

      const answerSdp = await whipRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // 6. Monitor connection
      pc.onconnectionstatechange = () => {
        console.log('PeerConnection state:', pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          console.warn('⚠️ Connection issue:', pc.connectionState);
        }
      };

      // 7. Update DB
      const hlsUrl = `${STREAM_BASE}${HLS_PATH}/${streamName}/index.m3u8`;
      const webrtcUrl = `${STREAM_BASE}${WHIP_PATH}/${streamName}`;
      await supabase.from('live_videos').update({
        status: 'live', actual_start: new Date().toISOString(),
        hls_url: hlsUrl, webrtc_url: webrtcUrl,
        is_active: true, started_by: admin.admin_id,
      }).eq('id', created.id);

      hideLoading();
      showToast('🔴 Camera live started!', 'success');
      camStatsCard.style.display = 'block';
      camTitle.value = '';
      startStatsPolling(created.id);
      startCamBtn.innerHTML = '<i class="bi bi-stop-circle-fill"></i> STOP CAMERA';
      startCamBtn.classList.remove('btn-live');
      startCamBtn.classList.add('btn-danger-custom');
      startCamBtn.dataset.liveId = created.id;
    } catch (err) {
      console.error('Camera error:', err);
      hideLoading();
      if (currentCameraStream) {
        cameraPreview.srcObject = currentCameraStream;
        cameraPreviewWrap.classList.add('active');
      }
      startCamBtn.innerHTML = '<i class="bi bi-x-circle-fill"></i> CLOSE CAMERA';
      startCamBtn.classList.remove('btn-live');
      startCamBtn.classList.add('btn-danger-custom');
      startCamBtn.dataset.manualClose = '1';
      delete startCamBtn.dataset.liveId;
      activeCameraLiveId = null;
      if (currentPeerConnection) { try { currentPeerConnection.close(); } catch (e) {} currentPeerConnection = null; }
      showDiagnostic('📷 Camera live failed', buildDiagnostics('Camera → WHIP', err, {
        'Stream name': streamName || '(not created)',
        'WHIP URL': whipUrl || '(not built)',
        'Live row ID': created?.id || '(not created)',
      }));
      showToast('Camera failed: ' + (err.message || err), 'error');
    }
  }

  async function stopCameraStreamAndUpdateDb() {
    const liveId = activeCameraLiveId || startCamBtn.dataset.liveId;
    stopCameraStream();
    cameraPreviewWrap.classList.remove('active');
    camStatsCard.style.display = 'none';
    stopStatsPolling();
    startCamBtn.innerHTML = '<i class="bi bi-camera-video-fill"></i> OPEN CAMERA';
    startCamBtn.classList.remove('btn-danger-custom');
    startCamBtn.classList.add('btn-live');
    delete startCamBtn.dataset.liveId;
    delete startCamBtn.dataset.manualClose;
    if (liveId) {
      try { await apiCall('stop', { live_id: liveId }); showToast('Stream stopped ✅', 'success'); } catch (err) { console.warn('Stop API error:', err); }
      activeCameraLiveId = null;
      await loadStreams();
    }
  }
  function closeCameraLocal() {
    stopCameraStream();
    cameraPreviewWrap.classList.remove('active');
    camStatsCard.style.display = 'none';
    stopStatsPolling();
    startCamBtn.innerHTML = '<i class="bi bi-camera-video-fill"></i> OPEN CAMERA';
    startCamBtn.classList.remove('btn-danger-custom');
    startCamBtn.classList.add('btn-live');
    delete startCamBtn.dataset.manualClose;
    delete startCamBtn.dataset.liveId;
    activeCameraLiveId = null;
  }
  function stopCameraStream() {
    if (currentPeerConnection) { try { currentPeerConnection.close(); } catch (e) {} currentPeerConnection = null; }
    if (currentCameraStream) { currentCameraStream.getTracks().forEach((t) => t.stop()); currentCameraStream = null; }
    if (cameraPreview) cameraPreview.srcObject = null;
  }

  // ════════════════════════════════════════════════════════════
  // LIVE STATS POLLING
  // ════════════════════════════════════════════════════════════
  function startStatsPolling(liveId) {
    stopStatsPolling();
    fetchAndRenderStats(liveId);
    statsPollTimer = setInterval(() => fetchAndRenderStats(liveId), 5000);
  }
  function stopStatsPolling() { if (statsPollTimer) { clearInterval(statsPollTimer); statsPollTimer = null; } }

  async function fetchAndRenderStats(liveId) {
    try {
      const data = await apiCall('live_stats', { live_id: liveId });
      const s = data.stats || {};
      camViews.textContent = s.views_count || 0;
      camLikes.textContent = s.likes_count || 0;
      camComments.textContent = s.comments_count || 0;
      const comments = data.comments || [];
      if (comments.length === 0) camCommentList.innerHTML = '<div class="comment-empty">No comments yet</div>';
      else camCommentList.innerHTML = comments.map((c) => `
        <div class="comment-item">
          <div class="comment-head"><span class="comment-user">${escapeHtml(c.user_name || 'Viewer')}</span><span class="comment-time">${formatMalawiTime(c.created_at)}</span></div>
          <div class="comment-msg">${escapeHtml(c.message || '')}</div>
        </div>`).join('');
    } catch (err) { console.warn('Stats fetch error:', err); }
  }

  // ════════════════════════════════════════════════════════════
  // STOP / RESTART STREAM
  // ════════════════════════════════════════════════════════════
  async function stopStream(liveId) {
    const stream = allStreams.find(s => s.id === liveId);
    if (!stream) return;
    const confirmed = await confirmModal('🛑 Stop Stream', `Stop "${stream.title}"?`, 'STOP');
    if (!confirmed) return;
    showLoading('Stopping…');
    try {
      if (stream.mode === 'camera') {
        stopCameraStream();
        cameraPreviewWrap.classList.remove('active');
        camStatsCard.style.display = 'none';
        stopStatsPolling();
        startCamBtn.innerHTML = '<i class="bi bi-camera-video-fill"></i> OPEN CAMERA';
        startCamBtn.classList.remove('btn-danger-custom');
        startCamBtn.classList.add('btn-live');
        delete startCamBtn.dataset.liveId;
        delete startCamBtn.dataset.manualClose;
        activeCameraLiveId = null;
      }
      await apiCall('stop', { live_id: liveId });
      hideLoading();
      showToast('Stream stopped ✅', 'success');
      await loadStreams();
    } catch (err) {
      hideLoading();
      showDiagnostic('Stop failed', buildDiagnostics('stop', err, { 'Live ID': liveId }));
      showToast('Failed: ' + err.message, 'error');
    }
  }
  async function restartStream(liveId) {
    const stream = allStreams.find(s => s.id === liveId);
    if (!stream || !stream.video_key) return showToast('No video file to restart', 'error');
    const confirmed = await confirmModal('🎬 Restart Stream', `Restart "${stream.title}"?`, 'RESTART');
    if (!confirmed) return;
    showLoading('Restarting…');
    try {
      await apiCall('start', { live_id: liveId, video_key: stream.video_key });
      hideLoading();
      showToast('Stream restarted ✅', 'success');
      await loadStreams();
    } catch (err) {
      hideLoading();
      showDiagnostic('Restart failed', buildDiagnostics('restart', err));
      showToast('Failed: ' + err.message, 'error');
    }
  }

  // ════════════════════════════════════════════════════════════
  // TABS
  // ════════════════════════════════════════════════════════════
  function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const tabEl = document.querySelector(`.tab[data-tab="${tabName}"]`);
    if (tabEl) tabEl.classList.add('active');
    const panel = document.getElementById('panel' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
    if (panel) panel.classList.add('active');
  }
  function initTabs() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
        if (tab.dataset.tab === 'streams') loadStreams();
      });
    });
  }
  function initUploadZone() {
    if (!uploadZone) return;
    uploadZone.addEventListener('click', () => mp4FileInput.click());
    mp4FileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      selectedMp4File = file;
      updateUploadZoneUI(file);
    });
    ['dragenter', 'dragover'].forEach((ev) => {
      uploadZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      uploadZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); uploadZone.classList.remove('dragover'); });
    });
    uploadZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('video/')) return showToast('Please drop a video file', 'error');
      selectedMp4File = file;
      updateUploadZoneUI(file);
    });
  }

  function init() {
    initTabs();
    initUploadZone();
    setupPriceToggle('mp4PriceToggle', 'mp4Price');
    setupPriceToggle('camPriceToggle', 'camPrice');
    if (startMp4Btn) startMp4Btn.addEventListener('click', startMp4Stream);
    if (startCamBtn) {
      startCamBtn.addEventListener('click', () => {
        if (startCamBtn.dataset.manualClose === '1') { closeCameraLocal(); return; }
        if (startCamBtn.dataset.liveId || activeCameraLiveId) { stopCameraStreamAndUpdateDb(); return; }
        startCameraStream();
      });
    }
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        window._manualRefresh = true;
        checkHealth();
        loadStreams();
        showToast('Refreshed ✅', 'success');
      });
    }
    checkHealth();
    loadStreams();
    liveRefreshTimer = setInterval(() => { checkHealth(); loadStreams(); }, 30000);
    window.addEventListener('beforeunload', () => {
      stopCameraStream();
      stopStatsPolling();
      if (liveRefreshTimer) clearInterval(liveRefreshTimer);
    });
  }

  window._adminStopStream = stopStream;
  window._adminRestartStream = restartStream;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

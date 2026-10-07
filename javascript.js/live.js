// live.js (v22 — Watermark + 1-100% Progress Bar + poster.gif + robust comment insert)
// ════════════════════════════════════════════════════════════
(function() {
  'use strict';

  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const HLS_PATH = '/hls';

  const AKMARK_TOKEN_KEY = 'akmark_token';
  const AKMARK_USER_KEY  = 'akmark_user';
  const LOGIN_URL = '/login.html';
  const PAY_API = `${SUPABASE_URL}/functions/v1/live-check-payments-api`;

  const STREAM_BASE = (function() {
    const h = window.location.hostname;
    if (!h) return 'https://akimark.mw';
    if (h === 'akimark.mw' || h === 'www.akimark.mw') return 'https://akimark.mw';
    if (h.endsWith('.akimark.mw')) return 'https://' + h;
    return 'https://akimark.mw';
  })();

  const POSTER_KEY = 'akimark_poster_v1_';
  const VIEWED_LIVES_KEY = 'akimark_viewed_lives_v1';
  const RECENT_COMMENTS_LIMIT = 5;
  const FULLSCREEN_COMMENTS_LIMIT = 10;
  const PRELOAD_POSTERS_MAX = 3;
  const VIEWED_LIVES_MAX = 500;
  const LOAD_TIMEOUT_MS = 8000;

  // v22: default poster gif
  const DEFAULT_POSTER_GIF = 'images/poster.gif';

  // ════════════════════════════════════════════════════════════
  // AUTH
  // ════════════════════════════════════════════════════════════
  function getAkimarkToken() {
    try { return localStorage.getItem(AKMARK_TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function getAkimarkUser() {
    try {
      const raw = localStorage.getItem(AKMARK_USER_KEY);
      if (!raw) return null;
      const u = JSON.parse(raw);
      if (!u || typeof u !== 'object') return null;
      return u;
    } catch (e) { return null; }
  }
  function setAkimarkUser(user) {
    try { localStorage.setItem(AKMARK_USER_KEY, JSON.stringify(user)); } catch (e) {}
  }
  function isAkimarkLoggedIn() { return !!getAkimarkToken(); }
  function getAkimarkDisplayName() {
    const u = getAkimarkUser();
    if (u && (u.full_name || u.name)) return u.full_name || u.name;
    return 'User';
  }
  function getAkimarkUserId() {
    const u = getAkimarkUser();
    if (!u) return null;
    return u.user_id || u.id || null;
  }

  function enforceLogin() {
    if (!isAkimarkLoggedIn()) {
      try {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(`${LOGIN_URL}?next=${next}`);
      } catch (e) {
        window.location.replace(LOGIN_URL);
      }
      return false;
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // SUPABASE
  // ════════════════════════════════════════════════════════════
  let supabase = null;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && typeof window.supabase.createClient === 'function') {
    try { supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let liveStreams = [];
  let previousStreams = [];
  let currentStream = null;
  let currentIsLive = false;
  let hls = null;
  let statsPollTimer = null;
  let loadTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  let watchdogTimer = null;
  let bufferingTimer = null;
  let posterCaptured = false;
  let controlsHideTimer = null;
  let controlsVisible = true;
  let lastCommentsSig = '';
  let seenCommentIds = new Set();
  let commentFadeTimers = new Map();
  let hasStartedPlayback = false;
  let lastProgressAt = 0;
  let stallDisabled = false;
  let recoveryAttempts = 0;
  let userLiked = false;
  let initialLoadDone = false;
  let loadTimeoutHandle = null;
  let isFullscreenNow = false;
  let paidLiveIds = new Set();

  // v22: progress bar state
  let progressValue = 0;
  let progressTimer = null;

  const posterQueue = [];
  let posterProcessing = false;

  // ════════════════════════════════════════════════════════════
  // DOM
  // ════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);
  let DOM = {};

  function bindDom() {
    DOM = {
      liveGrid: $('liveGrid'), liveCount: $('liveCount'), emptyState: $('emptyState'),
      navLiveBadge: $('navLiveBadge'), toast: $('toast'), toastMsg: $('toastMsg'),
      previousSection: $('previousSection'), previousGrid: $('previousGrid'), prevCount: $('prevCount'),
      streamModal: $('streamModal'), streamStage: $('streamStage'),
      streamClose: $('streamClose'), streamVideo: $('streamVideo'),
      videoLoader: $('videoLoader'), videoLoaderText: $('videoLoaderText'),
      videoProgressBar: $('videoProgressBar'), videoProgressPct: $('videoProgressPct'),
      bufferingIndicator: $('bufferingIndicator'),
      streamModalLabel: $('streamModalLabel'), modalTitle: $('modalTitle'),
      modalBroadcaster: $('modalBroadcaster'), modalViews: $('modalViews'),
      modalCommentList: $('modalCommentList'), reactionLayer: $('reactionLayer'),
      likeBtn: $('likeBtn'), likeCount: $('likeCount'),
      commentCount: $('commentCount'), commentFocusBtn: $('commentFocusBtn'),
      commentInput: $('commentInput'), commentSend: $('commentSend'),
      streamTopbar: $('streamTopbar'), streamBottombar: $('streamBottombar'),
      streamTapLayer: $('streamTapLayer'),
      fullscreenBtn: $('fullscreenBtn'),
      reactionsToggleBtn: $('reactionsToggleBtn'),
      reactionsPicker: $('reactionsPicker'),
      reactionsPickerInner: $('reactionsPickerInner'),
      userBadge: $('userBadge'),
      userBadgeAv: $('userBadgeAv'),
      userBadgeName: $('userBadgeName'),
      gifLoadingOverlay: $('gifLoadingOverlay'),
      gifLoadingText: $('gifLoadingText'),
      streamWatermark: $('streamWatermark'),
    };
  }

  // ════════════════════════════════════════════════════════════
  // UTILS
  // ════════════════════════════════════════════════════════════
  function escapeHtmlText(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const diff = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${d.getDate()} ${m[d.getMonth()]}`;
    } catch (e) { return '—'; }
  }
  function formatMWK(n) { return 'MWK ' + Number(n || 0).toLocaleString(); }
  function initials(name) {
    const n = (name || 'A').trim();
    const parts = n.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  function showToast(msg, opts) {
    if (!DOM.toast || !DOM.toastMsg) return;
    DOM.toastMsg.textContent = msg;
    DOM.toast.classList.toggle('welcome', !!(opts && opts.welcome));
    DOM.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      DOM.toast.classList.remove('show');
      DOM.toast.classList.remove('welcome');
    }, opts && opts.duration ? opts.duration : 2600);
  }

  function showGifLoading(text) {
    if (!DOM.gifLoadingOverlay) return;
    if (DOM.gifLoadingText) DOM.gifLoadingText.textContent = text || 'Loading…';
    DOM.gifLoadingOverlay.classList.add('show');
  }
  function hideGifLoading() {
    if (!DOM.gifLoadingOverlay) return;
    DOM.gifLoadingOverlay.classList.remove('show');
  }
  function updateGifLoadingText(text) {
    if (DOM.gifLoadingText) DOM.gifLoadingText.textContent = text;
  }

  // ════════════════════════════════════════════════════════════
  // v22: PROGRESS BAR (1% - 100%)
  // ════════════════════════════════════════════════════════════
  function resetProgress() {
    progressValue = 1;
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    updateProgressUI(1);
  }
  function updateProgressUI(v) {
    progressValue = Math.max(1, Math.min(100, v));
    if (DOM.videoProgressBar) DOM.videoProgressBar.style.width = progressValue + '%';
    if (DOM.videoProgressPct) DOM.videoProgressPct.textContent = Math.round(progressValue) + '%';
  }
  function startProgressSimulation() {
    resetProgress();
    // Simulate load: 1% → 95% over ~12s
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (progressValue >= 95) {
        clearInterval(progressTimer);
        progressTimer = null;
        return;
      }
      // Slow down as it gets closer to 95
      const step = progressValue < 30 ? 2.5
                 : progressValue < 60 ? 1.4
                 : progressValue < 80 ? 0.8
                 : 0.35;
      updateProgressUI(progressValue + step);
    }, 220);
  }
  function completeProgress() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    updateProgressUI(100);
    // Slight delay then hide loader
    setTimeout(() => {
      if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
    }, 300);
  }
  function stopProgress() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  }

  function getStoredPoster(id) {
    try { return localStorage.getItem(POSTER_KEY + id) || null; } catch (e) { return null; }
  }
  function setStoredPoster(id, url) {
    try { localStorage.setItem(POSTER_KEY + id, url); } catch (e) {}
  }

  function getViewedLives() {
    try {
      const raw = localStorage.getItem(VIEWED_LIVES_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function markLiveViewed(liveId) {
    try {
      const list = getViewedLives();
      if (list.includes(liveId)) return false;
      list.push(liveId);
      while (list.length > VIEWED_LIVES_MAX) list.shift();
      localStorage.setItem(VIEWED_LIVES_KEY, JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }

  function renderUserBadge() {
    if (!DOM.userBadge) return;
    const user = getAkimarkUser();
    const name = (user && (user.full_name || user.name || user.email)) || 'User';
    if (DOM.userBadgeAv) DOM.userBadgeAv.textContent = initials(name);
    if (DOM.userBadgeName) DOM.userBadgeName.textContent = name;
    DOM.userBadge.style.display = 'inline-flex';
  }

  function buildHlsUrl(stream) {
    let url = stream.hls_url;
    if (!url && stream.stream_key) {
      url = stream.mode === 'camera'
        ? `${HLS_PATH}/live/${stream.stream_key}/index.m3u8`
        : `${HLS_PATH}/${stream.stream_key}/index.m3u8`;
    }
    if (!url) return null;
    if (url.startsWith('/')) return STREAM_BASE + url;
    try {
      const u = new URL(url);
      if (u.hostname.endsWith('.akimark.mw') || u.hostname === 'akimark.mw') {
        return STREAM_BASE + u.pathname + u.search;
      }
    } catch (e) {
      return STREAM_BASE + '/' + url.replace(/^\/+/, '');
    }
    return url;
  }

  async function loadPaidLiveIds() {
    if (!supabase) return;
    const userId = getAkimarkUserId();
    if (!userId) return;
    try {
      const { data } = await supabase
        .from('live_payments')
        .select('live_id')
        .eq('user_id', userId)
        .eq('status', 'success');
      paidLiveIds = new Set((data || []).map((r) => r.live_id));
    } catch (e) {}
  }

  function renderSkeletons() {
    if (!DOM.liveGrid) return;
    const sk = Array.from({length: 3}).map(() => `
      <div class="skeleton-card">
        <div class="skeleton-thumb"></div>
        <div class="skeleton-body">
          <div class="skeleton-line w-80"></div>
          <div class="skeleton-line w-50"></div>
          <div class="skeleton-line w-30"></div>
        </div>
      </div>
    `).join('');
    DOM.liveGrid.innerHTML = sk;
  }

  async function loadAll() {
    if (!supabase) {
      initialLoadDone = true;
      renderAll();
      return;
    }
    if (!initialLoadDone) renderSkeletons();

    try {
      const liveRes = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,webrtc_url,is_active,actual_start,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price,admin_id', { count: 'exact' })
        .eq('status', 'live').eq('is_active', true)
        .order('actual_start', { ascending: false }).limit(50);
      if (liveRes.error) throw liveRes.error;
      liveStreams = liveRes.data || [];

      const prevRes = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,actual_start,actual_end,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price')
        .eq('status', 'ended').order('actual_end', { ascending: false }).limit(6);
      previousStreams = (prevRes && prevRes.data) ? prevRes.data : [];

      await loadPaidLiveIds();

      initialLoadDone = true;
      if (loadTimeoutHandle) { clearTimeout(loadTimeoutHandle); loadTimeoutHandle = null; }
      renderAll();

      if (!currentStream) {
        liveStreams.slice(0, PRELOAD_POSTERS_MAX).forEach(enqueuePosterCapture);
      }
    } catch (err) {
      initialLoadDone = true;
      if (loadTimeoutHandle) { clearTimeout(loadTimeoutHandle); loadTimeoutHandle = null; }
      renderAll();
    }
  }

  function renderAll() {
    if (DOM.liveCount) DOM.liveCount.textContent = liveStreams.length;
    if (liveStreams.length > 0) {
      if (DOM.navLiveBadge) DOM.navLiveBadge.classList.remove('off');
      document.title = `LIVE (${liveStreams.length}) | Akimark`;
    } else {
      if (DOM.navLiveBadge) DOM.navLiveBadge.classList.add('off');
      document.title = 'Live | Akimark';
    }

    if (!DOM.liveGrid) return;
    if (liveStreams.length === 0) {
      DOM.liveGrid.innerHTML = '';
      if (DOM.emptyState) DOM.emptyState.style.display = 'block';
    } else {
      if (DOM.emptyState) DOM.emptyState.style.display = 'none';
      DOM.liveGrid.innerHTML = liveStreams.map((s) => cardHTML(s, true)).join('');
      DOM.liveGrid.querySelectorAll('.live-card').forEach((el) => {
        el.addEventListener('click', () => openStream(el.dataset.id, true));
      });
    }

    if (previousStreams.length > 0 && DOM.previousSection && DOM.previousGrid) {
      DOM.previousSection.style.display = 'block';
      if (DOM.prevCount) DOM.prevCount.textContent = String(previousStreams.length);
      DOM.previousGrid.innerHTML = previousStreams.map((s) => cardHTML(s, false)).join('');
      DOM.previousGrid.querySelectorAll('.live-card').forEach((el) => {
        el.addEventListener('click', () => openStream(el.dataset.id, false));
      });
    } else if (DOM.previousSection) {
      DOM.previousSection.style.display = 'none';
    }

    const urlStreamId = getStreamIdFromUrl();
    if (urlStreamId && !currentStream) {
      const inLive = liveStreams.find((s) => s.id === urlStreamId);
      const inPrev = previousStreams.find((s) => s.id === urlStreamId);
      if (inLive) setTimeout(() => openStream(urlStreamId, true, true), 200);
      else if (inPrev) setTimeout(() => openStream(urlStreamId, false, true), 200);
    }
  }

  function cardHTML(s, isLive) {
    const isFree = s.is_free !== false;
    const userHasPaid = !isFree && paidLiveIds.has(s.id);
    const priceLabel = isFree ? 'Free' : (userHasPaid ? 'Unlocked' : formatMWK(s.price));
    const priceClass = isFree ? 'free' : (userHasPaid ? 'unlocked' : 'paid');
    const views = s.views_count || 0;
    const likes = s.likes_count || 0;
    const broadcaster = s.broadcaster_name || 'Akimark';
    const av = initials(broadcaster);
    const cardClass = isLive ? 'is-live' : 'is-ended';
    const badgeClass = isLive ? 'live-badge-card' : 'live-badge-card ended';
    const badgeLabel = isLive ? 'LIVE' : 'ENDED';
    const timeRef = isLive ? (s.actual_start || s.created_at) : (s.actual_end || s.actual_start || s.created_at);
    const timeLabel = isLive ? 'Started ' + formatTime(timeRef) : 'Ended ' + formatTime(timeRef);

    // ═══ v22: DEFAULT POSTER = images/poster.gif ═══
    // If we have a captured poster, show it; otherwise show poster.gif
    const capturedPoster = getStoredPoster(s.id);
    const posterSrc = capturedPoster || DEFAULT_POSTER_GIF;

    const paidBadge = userHasPaid ? `<span class="live-paid-badge">✓ Paid</span>` : '';

    return `
      <div class="live-card ${cardClass}" data-id="${s.id}">
        <div class="live-thumb">
          <img class="live-thumb-poster ready" src="${posterSrc}" alt="" onerror="this.onerror=null; this.src='${DEFAULT_POSTER_GIF}';">
          <span class="${badgeClass}">${badgeLabel}</span>
          ${paidBadge}
          <span class="live-viewers"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${views}</span>
          <span class="live-price ${priceClass}">${escapeHtmlText(priceLabel)}</span>
        </div>
        <div class="live-info">
          <div class="live-title">${escapeHtmlText(s.title || 'Live Stream')}</div>
          <div class="live-broadcaster"><div class="avatar">${escapeHtmlText(av)}</div><span>${escapeHtmlText(broadcaster)}</span></div>
          <div class="live-stats-row">
            <span><svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${likes}</span>
            <span><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${s.comments_count || 0}</span>
            <span style="margin-left:auto;">${timeLabel}</span>
          </div>
        </div>
      </div>`;
  }

  async function checkStreamAccess(stream) {
    if (stream.is_free !== false) return { allowed: true };
    if (paidLiveIds.has(stream.id)) return { allowed: true, already_paid: true };

    try {
      const res = await fetch(PAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getAkimarkToken(),
        },
        body: JSON.stringify({ action: 'check_payment', live_id: stream.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { allowed: false, reason: 'error', message: data.error || 'Check failed' };
      }
      if (data.allowed) {
        if (data.has_paid) paidLiveIds.add(stream.id);
        return { allowed: true, already_paid: data.has_paid };
      }
      return { allowed: false, reason: 'payment_required', price: data.price, wallet_balance: data.wallet_balance };
    } catch (e) {
      return { allowed: false, reason: 'error', message: 'Network error' };
    }
  }

  function showPaymentPrompt(stream, price, walletBalance) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'live-gate-overlay';
      overlay.innerHTML = `
        <div class="live-gate-modal">
          <div class="gate-icon paid"><span style="font-size:1.6rem">💰</span></div>
          <h3>Paid Live Stream</h3>
          <p class="gate-sub">${escapeHtmlText(stream.title || 'Live Stream')}</p>
          <div class="gate-price-row">
            <span>Price</span>
            <strong>${formatMWK(price)}</strong>
          </div>
          <div class="gate-price-row">
            <span>Your Balance</span>
            <strong class="${walletBalance >= price ? 'ok' : 'low'}">${formatMWK(walletBalance)}</strong>
          </div>
          ${walletBalance < price ? `
            <div class="gate-warn">
              <span>⚠️</span>
              Insufficient balance. Please top up your wallet.
            </div>` : ''}
          <div class="gate-actions">
            <button class="gate-btn secondary" id="gateCancel">Cancel</button>
            ${walletBalance >= price
              ? `<button class="gate-btn primary" id="gateConfirm">Pay & Watch</button>`
              : `<a class="gate-btn primary" href="/deposit">Top Up</a>`}
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const cleanup = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelector('#gateCancel').onclick = () => cleanup(false);
      const confirmBtn = overlay.querySelector('#gateConfirm');
      if (confirmBtn) confirmBtn.onclick = () => cleanup(true);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    });
  }

  async function payForLive(stream) {
    try {
      const res = await fetch(PAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getAkimarkToken(),
        },
        body: JSON.stringify({ action: 'pay_and_watch', live_id: stream.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.message || data.error || 'Payment failed', { duration: 4000 });
        return false;
      }
      const user = getAkimarkUser();
      if (user && data.new_balance !== undefined) {
        user.wallet_balance = data.new_balance;
        setAkimarkUser(user);
      }
      paidLiveIds.add(stream.id);
      showToast(data.already_paid ? 'Already paid — enjoy!' : 'Payment successful!', { duration: 3000 });
      return true;
    } catch (e) {
      showToast('Network error during payment', { duration: 4000 });
      return false;
    }
  }

  function getStreamIdFromUrl() {
    try { return new URLSearchParams(window.location.search).get('stream'); } catch (e) { return null; }
  }
  function setStreamUrl(streamId) {
    try {
      const url = new URL(window.location.href);
      if (streamId) url.searchParams.set('stream', streamId);
      else url.searchParams.delete('stream');
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
  }

  async function openStream(id, isLive, fromUrl) {
    const list = isLive ? liveStreams : previousStreams;
    const stream = list.find((s) => s.id === id);
    if (!stream) {
      if (!fromUrl) showToast('Stream not found');
      return;
    }

    showGifLoading('Checking access…');

    const access = await checkStreamAccess(stream);

    if (!access.allowed) {
      hideGifLoading();
      if (access.reason === 'payment_required') {
        const confirmed = await showPaymentPrompt(stream, access.price, access.wallet_balance);
        if (!confirmed) return;
        showGifLoading('Processing payment…');
        const paid = await payForLive(stream);
        if (!paid) { hideGifLoading(); return; }
        updateGifLoadingText('Opening stream…');
      } else {
        showToast(access.message || 'Access denied', { duration: 3500 });
        return;
      }
    }

    updateGifLoadingText('Opening stream…');

    currentStream = stream;
    currentIsLive = isLive;
    posterCaptured = false;
    hasStartedPlayback = false;
    stallDisabled = false;
    recoveryAttempts = 0;
    lastProgressAt = Date.now();
    seenCommentIds.clear();
    lastCommentsSig = '';
    userLiked = false;

    if (!fromUrl) setStreamUrl(stream.id);

    if (DOM.modalTitle) DOM.modalTitle.textContent = stream.title || 'Live Stream';
    const broadcaster = stream.broadcaster_name || 'Akimark';
    if (DOM.modalBroadcaster) DOM.modalBroadcaster.textContent = broadcaster;
    if (DOM.modalViews) DOM.modalViews.textContent = stream.views_count || 0;
    if (DOM.likeCount) DOM.likeCount.textContent = stream.likes_count || 0;
    if (DOM.commentCount) DOM.commentCount.textContent = stream.comments_count || 0;
    if (DOM.likeBtn) DOM.likeBtn.classList.remove('liked');

    if (DOM.streamModalLabel) {
      DOM.streamModalLabel.textContent = isLive ? 'LIVE' : 'ENDED';
      DOM.streamModalLabel.classList.toggle('ended', !isLive);
    }

    // v22: always show watermark
    if (DOM.streamWatermark) DOM.streamWatermark.style.display = 'inline-flex';

    if (DOM.modalCommentList) DOM.modalCommentList.innerHTML = '';
    if (DOM.reactionLayer) DOM.reactionLayer.innerHTML = '';
    if (DOM.commentInput) DOM.commentInput.value = '';
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');

    const cachedPoster = getStoredPoster(stream.id) || DEFAULT_POSTER_GIF;
    if (DOM.streamVideo) {
      try { DOM.streamVideo.poster = cachedPoster; } catch (e) {}
    }

    if (DOM.streamModal) DOM.streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    showControls(true);

    if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Connecting…';
    if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');

    // v22: start progress 1% → 95%
    startProgressSimulation();

    hideBuffering();

    retryCount = 0;
    attachHls(stream, isLive);

    if (isLive) {
      const isNew = markLiveViewed(stream.id);
      if (isNew) incrementView(stream.id);
    }

    startStatsPolling(stream.id, isLive);
    prefetchComments(stream.id);

    setTimeout(hideGifLoading, 250);
  }

  async function prefetchComments(streamId) {
    if (!supabase || !DOM.modalCommentList) return;
    try {
      const { data } = await supabase
        .from('live_comments')
        .select('id,user_name,message,created_at,user_id')
        .eq('live_id', streamId)
        .order('created_at', { ascending: false })
        .limit(RECENT_COMMENTS_LIMIT);
      if (data && data.length) renderComments(data);
    } catch (e) {}
  }

  function closeStream() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
    stopProgress();
    if (DOM.streamModal) DOM.streamModal.classList.remove('open');
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      try {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } catch (e) {}
    }
    document.body.style.overflow = '';
    stopStatsPolling();
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (DOM.streamVideo) {
      try { DOM.streamVideo.pause(); } catch (e) {}
      DOM.streamVideo.removeAttribute('src');
      try { DOM.streamVideo.load(); } catch (e) {}
    }
    commentFadeTimers.forEach((t) => clearTimeout(t));
    commentFadeTimers.clear();
    currentStream = null;
    currentIsLive = false;
    hasStartedPlayback = false;
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');
    setStreamUrl(null);
  }

  async function attachHls(stream, isLive) {
    const hlsUrl = buildHlsUrl(stream);

    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (DOM.streamVideo) {
      try { DOM.streamVideo.pause(); } catch (e) {}
      DOM.streamVideo.removeAttribute('src');
      try { DOM.streamVideo.load(); } catch (e) {}
    }

    if (!hlsUrl) {
      stopProgress();
      if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
      showToast('Stream unavailable');
      hideGifLoading();
      return;
    }

    try {
      const res = await fetch(hlsUrl, { method: 'GET', mode: 'cors', credentials: 'include', cache: 'no-store' });
      const body = await res.text().catch(() => '');
      if (res.status === 404 || res.status >= 500) {
        retryCount++;
        if (retryCount <= 30) {
          retryTimer = setTimeout(() => attachHls(stream, isLive), 2500);
        } else {
          stopProgress();
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream unavailable';
          hideGifLoading();
        }
        return;
      }
      if (res.status === 200 && !body.includes('#EXTM3U')) {
        if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Loading…';
      }
    } catch (fetchErr) {}

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 40,
        maxMaxBufferLength: 90,
        maxBufferSize: 90 * 1000 * 1000,
        maxBufferHole: 1.0,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 12,
        highBufferWatchdogPeriod: 2,
        abrEwmaDefaultEstimate: 800000,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.75,
        startLevel: -1,
        fragLoadingMaxRetry: 10,
        fragLoadingMaxRetryTimeout: 64000,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 8,
        enableWorker: true,
        xhrSetup: function (xhr) { xhr.withCredentials = true; },
      });

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (DOM.streamVideo) {
          DOM.streamVideo.muted = false;
          DOM.streamVideo.volume = 1;
          const p = DOM.streamVideo.play();
          if (p && p.catch) p.catch(() => {
            DOM.streamVideo.muted = true;
            DOM.streamVideo.play().catch(() => {});
          });
        }
      });

      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;

        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          const playing = DOM.streamVideo && !DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2 && DOM.streamVideo.currentTime > 0;
          if (playing) {
            showBuffering();
            try { hls.startLoad(); } catch (e) {}
            scheduleHideBuffering(4000);
          } else {
            if (!hasStartedPlayback) {
              if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Connecting…';
              if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
            } else {
              showBuffering();
            }
            setTimeout(() => { try { hls.startLoad(); } catch (e) {} }, 1000);
          }
          return;
        }

        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
          return;
        }

        stallDisabled = true;
        if (!hasStartedPlayback) {
          stopProgress();
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = isLive ? 'Stream ended' : 'Replay unavailable';
          hideGifLoading();
        }
      });

      const onFirstPlay = () => {
        if (hasStartedPlayback) return;
        hasStartedPlayback = true;
        // v22: complete the progress bar to 100% then hide loader
        completeProgress();
        hideBuffering();
        hideGifLoading();
        showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
        if (!posterCaptured) {
          posterCaptured = true;
          setTimeout(() => capturePoster(stream.id), 1500);
        }
      };

      DOM.streamVideo.addEventListener('playing', onFirstPlay);

      DOM.streamVideo.addEventListener('timeupdate', () => {
        lastProgressAt = Date.now();
        recoveryAttempts = 0;
        if (!hasStartedPlayback) onFirstPlay();
        if (!DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2) hideBuffering();
      });

      DOM.streamVideo.addEventListener('waiting', () => {
        if (hasStartedPlayback && !DOM.streamVideo.paused) showBuffering();
      });

      DOM.streamVideo.addEventListener('canplay', () => hideBuffering());

      hls.loadSource(hlsUrl);
      hls.attachMedia(DOM.streamVideo);

      watchdogTimer = setInterval(() => {
        if (!hls || !DOM.streamVideo || !isLive) return;
        if (stallDisabled) return;
        if (!hasStartedPlayback) return;
        if (DOM.streamVideo.paused || DOM.streamVideo.ended) return;

        const timeSinceProgress = Date.now() - lastProgressAt;
        if (timeSinceProgress > 3500) {
          recoveryAttempts++;
          if (recoveryAttempts === 1) {
            try { hls.startLoad(); } catch (e) {}
          } else if (recoveryAttempts <= 3) {
            try {
              const b = DOM.streamVideo.buffered;
              if (b.length > 0) {
                const lastEnd = b.end(b.length - 1);
                if (lastEnd > DOM.streamVideo.currentTime + 0.5) {
                  DOM.streamVideo.currentTime = lastEnd - 0.5;
                  DOM.streamVideo.play().catch(() => {});
                } else {
                  hls.startLoad();
                }
              }
            } catch (e) {}
          } else {
            try {
              const b = DOM.streamVideo.buffered;
              if (b.length > 0) {
                const liveEdge = b.end(b.length - 1);
                DOM.streamVideo.currentTime = Math.max(0, liveEdge - 1.5);
                DOM.streamVideo.play().catch(() => {});
              } else {
                hls.startLoad(-1);
              }
            } catch (e) {}
          }
          lastProgressAt = Date.now();
        }
      }, 1600);

    } else if (DOM.streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
      DOM.streamVideo.src = hlsUrl;
      DOM.streamVideo.crossOrigin = 'use-credentials';
      DOM.streamVideo.muted = false;
      DOM.streamVideo.volume = 1;
      DOM.streamVideo.addEventListener('loadedmetadata', () => {
        completeProgress();
        DOM.streamVideo.play().catch(() => {
          DOM.streamVideo.muted = true;
          DOM.streamVideo.play().catch(() => {});
        });
        if (!hasStartedPlayback) {
          hasStartedPlayback = true;
          hideGifLoading();
          if (!posterCaptured) {
            posterCaptured = true;
            setTimeout(() => capturePoster(stream.id), 1500);
          }
          showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
        }
      }, { once: true });
    } else {
      stopProgress();
      if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Playback not supported';
      hideGifLoading();
    }
  }

  function showBuffering() { if (DOM.bufferingIndicator) DOM.bufferingIndicator.classList.add('show'); }
  function hideBuffering() { if (DOM.bufferingIndicator) DOM.bufferingIndicator.classList.remove('show'); }
  function scheduleHideBuffering(ms) {
    if (bufferingTimer) clearTimeout(bufferingTimer);
    bufferingTimer = setTimeout(() => hideBuffering(), ms);
  }

  function capturePoster(streamId) {
    try {
      const video = DOM.streamVideo;
      if (!video || video.readyState < 2) return;
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', 0.72);
      if (url && url.length < 120000) {
        setStoredPoster(streamId, url);
        updateCardPoster(streamId, url);
      }
    } catch (e) {}
  }

  function updateCardPoster(streamId, url) {
    document.querySelectorAll(`.live-card[data-id="${streamId}"] .live-thumb-poster`).forEach((img) => {
      img.src = url;
      img.classList.add('ready');
    });
  }

  function enqueuePosterCapture(stream) {
    if (!stream || !stream.id) return;
    if (getStoredPoster(stream.id)) return;
    if (posterQueue.find((s) => s.id === stream.id)) return;
    posterQueue.push(stream);
    processPosterQueue();
  }

  async function processPosterQueue() {
    if (posterProcessing) return;
    if (currentStream) return;
    posterProcessing = true;
    while (posterQueue.length) {
      if (currentStream) break;
      const stream = posterQueue.shift();
      try { await capturePosterBackground(stream); } catch (e) {}
      await new Promise((r) => setTimeout(r, 800));
    }
    posterProcessing = false;
  }

  function capturePosterBackground(stream) {
    return new Promise((resolve) => {
      const url = buildHlsUrl(stream);
      if (!url) return resolve();

      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none;';
      document.body.appendChild(v);

      let done = false;
      let hlsBg = null;
      const cleanup = () => {
        if (done) return;
        done = true;
        try { if (hlsBg) hlsBg.destroy(); } catch (e) {}
        try { v.pause(); } catch (e) {}
        try { v.removeAttribute('src'); v.load(); } catch (e) {}
        try { v.remove(); } catch (e) {}
        resolve();
      };

      const failTimer = setTimeout(cleanup, 9000);

      const grab = () => {
        try {
          const w = v.videoWidth, h = v.videoHeight;
          if (!w || !h) { clearTimeout(failTimer); cleanup(); return; }
          const c = document.createElement('canvas');
          c.width = 480; c.height = 270;
          c.getContext('2d').drawImage(v, 0, 0, 480, 270);
          const dataUrl = c.toDataURL('image/jpeg', 0.7);
          if (dataUrl && dataUrl.length < 120000) {
            setStoredPoster(stream.id, dataUrl);
            updateCardPoster(stream.id, dataUrl);
          }
        } catch (e) {}
        clearTimeout(failTimer);
        cleanup();
      };

      v.addEventListener('loadeddata', () => setTimeout(grab, 900), { once: true });
      v.addEventListener('error', () => { clearTimeout(failTimer); cleanup(); });

      if (window.Hls && window.Hls.isSupported()) {
        hlsBg = new window.Hls({ lowLatencyMode: false, maxBufferLength: 8, maxMaxBufferLength: 12, enableWorker: true, startLevel: -1 });
        hlsBg.on(window.Hls.Events.ERROR, (_e, d) => { if (d.fatal) { clearTimeout(failTimer); cleanup(); } });
        hlsBg.loadSource(url);
        hlsBg.attachMedia(v);
        v.play().catch(() => {});
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
        v.play().catch(() => {});
      } else {
        clearTimeout(failTimer);
        cleanup();
      }
    });
  }

  async function incrementView(liveId) {
    try {
      const { data: cur } = await supabase.from('live_videos').select('views_count').eq('id', liveId).maybeSingle();
      const next = (cur?.views_count || 0) + 1;
      await supabase.from('live_videos').update({ views_count: next }).eq('id', liveId);
      if (currentStream && currentStream.id === liveId) {
        currentStream.views_count = next;
        if (DOM.modalViews) DOM.modalViews.textContent = next;
      }
    } catch (e) {}
  }

  function startStatsPolling(liveId, isLive) {
    stopStatsPolling();
    fetchStats(liveId, isLive);
    statsPollTimer = setInterval(() => fetchStats(liveId, isLive), 5000);
  }
  function stopStatsPolling() {
    if (statsPollTimer) { clearInterval(statsPollTimer); statsPollTimer = null; }
  }

  async function fetchStats(liveId, isLive) {
    try {
      const { data: live } = await supabase
        .from('live_videos').select('views_count,likes_count,comments_count,status,is_active')
        .eq('id', liveId).maybeSingle();
      if (!live) return;

      if (DOM.modalViews) DOM.modalViews.textContent = live.views_count || 0;
      if (DOM.likeCount && !userLiked) DOM.likeCount.textContent = live.likes_count || 0;
      if (DOM.commentCount) DOM.commentCount.textContent = live.comments_count || 0;
      if (currentStream) {
        currentStream.views_count = live.views_count || 0;
        if (!userLiked) currentStream.likes_count = live.likes_count || 0;
        currentStream.comments_count = live.comments_count || 0;
      }

      if (isLive && (live.status !== 'live' || live.is_active === false)) {
        if (DOM.streamModalLabel) {
          DOM.streamModalLabel.textContent = 'ENDED';
          DOM.streamModalLabel.classList.add('ended');
        }
        if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        stopStatsPolling();
      }

      const limit = isFullscreenNow ? FULLSCREEN_COMMENTS_LIMIT : RECENT_COMMENTS_LIMIT;
      const { data: comments } = await supabase
        .from('live_comments').select('id,user_name,message,created_at,user_id')
        .eq('live_id', liveId).order('created_at', { ascending: false }).limit(limit);

      renderComments(comments || []);
    } catch (e) {}
  }

  function renderComments(comments) {
    if (!DOM.modalCommentList) return;
    const sig = comments.map((c) => c.id).join('|');
    if (sig === lastCommentsSig) return;
    lastCommentsSig = sig;

    const limit = isFullscreenNow ? FULLSCREEN_COMMENTS_LIMIT : RECENT_COMMENTS_LIMIT;
    const limited = comments.slice(0, limit);
    const ordered = limited.slice().reverse();

    DOM.modalCommentList.innerHTML = '';
    ordered.forEach((c) => {
      const bubble = document.createElement('div');
      bubble.className = 'comment-bubble';
      bubble.dataset.id = c.id;
      const av = initials(c.user_name || 'Viewer');
      bubble.innerHTML = `
        <div class="c-avatar">${escapeHtmlText(av)}</div>
        <div class="c-body">
          <div class="c-name">${escapeHtmlText(c.user_name || 'Viewer')}</div>
          <div class="c-msg">${escapeHtmlText(c.message || '')}</div>
        </div>`;
      DOM.modalCommentList.appendChild(bubble);

      if (currentIsLive && !seenCommentIds.has(c.id)) {
        seenCommentIds.add(c.id);
        const t = setTimeout(() => {
          bubble.classList.add('fade');
          setTimeout(() => { try { bubble.remove(); } catch (e) {} }, 700);
        }, 14000);
        commentFadeTimers.set(c.id, t);
      }
    });

    DOM.modalCommentList.scrollTop = DOM.modalCommentList.scrollHeight;
  }

  let likeInFlight = false;

  async function toggleLike() {
    if (!currentStream || likeInFlight) return;
    likeInFlight = true;

    const alreadyLiked = DOM.likeBtn && DOM.likeBtn.classList.contains('liked');
    const delta = alreadyLiked ? -1 : 1;
    const newCount = Math.max(0, (currentStream.likes_count || 0) + delta);

    currentStream.likes_count = newCount;
    if (DOM.likeCount) DOM.likeCount.textContent = newCount;
    if (DOM.likeBtn) DOM.likeBtn.classList.toggle('liked', !alreadyLiked);
    userLiked = !alreadyLiked;

    if (!alreadyLiked) spawnHeart();

    try {
      await supabase.from('live_videos').update({ likes_count: newCount }).eq('id', currentStream.id);
    } catch (e) {}

    likeInFlight = false;
  }

  const HEART_SVG = `
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff4d4d"/>
          <stop offset="100%" stop-color="#c71515"/>
        </linearGradient>
      </defs>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" fill="url(#hg)"/>
    </svg>`;

  function spawnHeart() {
    if (!DOM.reactionLayer) return;
    const el = document.createElement('div');
    el.className = 'float-heart';
    el.innerHTML = HEART_SVG;
    const left = 40 + Math.random() * 60;
    el.style.left = left + 'px';
    el.style.bottom = '120px';
    el.style.transform = `translateX(${(Math.random() - 0.5) * 40}px)`;
    DOM.reactionLayer.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 2400);
  }

  const REACTIONS = [
    { key: 'like', label: 'Like', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_like" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#5eb1ff"/><stop offset="1" stop-color="#0d6efd"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_like)"/><path d="M28 18h-4.2v-4.4c0-1.1-.6-1.8-1.7-1.8h-1.6c-.6 0-1.1.5-1.2 1.1l-.5 3.2c-.1.6-.5 1-1.1 1.3l-3.9 1.9h-.9c-.6 0-1.1.5-1.1 1.1v6.1c0 .6.5 1.1 1.1 1.1h9.6c.7 0 1.3-.5 1.4-1.2l1.5-5.2c.2-.6.1-1.3-.2-1.8-.3-.5-.8-.8-1.4-.8z" fill="#fff"/></svg>` },
    { key: 'love', label: 'Love', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_love" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ff6b8a"/><stop offset="1" stop-color="#e0245e"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_love)"/><path d="M20 28s-8-5-8-11.2c0-2.8 2.2-5 5-5 1.7 0 3.2.8 4 2.1.8-1.3 2.3-2.1 4-2.1 2.8 0 5 2.2 5 5C30 23 20 28 20 28z" fill="#fff"/></svg>` },
    { key: 'haha', label: 'Haha', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_haha" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_haha)"/><circle cx="14.5" cy="17" r="1.7" fill="#3a2b00"/><circle cx="25.5" cy="17" r="1.7" fill="#3a2b00"/><path d="M11.5 22.5c1 3.3 4.3 5.5 8.5 5.5s7.5-2.2 8.5-5.5" stroke="#3a2b00" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M14 26.6c1.7 1.2 4 1.2 6 0" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>` },
    { key: 'wow', label: 'Wow', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_wow" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_wow)"/><ellipse cx="14.5" cy="17" rx="1.8" ry="2.3" fill="#3a2b00"/><ellipse cx="25.5" cy="17" rx="1.8" ry="2.3" fill="#3a2b00"/><ellipse cx="20" cy="26" rx="3.2" ry="4.2" fill="#3a2b00"/></svg>` },
    { key: 'sad', label: 'Sad', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_sad" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_sad)"/><circle cx="14.5" cy="17" r="1.7" fill="#3a2b00"/><circle cx="25.5" cy="17" r="1.7" fill="#3a2b00"/><path d="M12 28c1.5-2.5 4-4 8-4s6.5 1.5 8 4" stroke="#3a2b00" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M26 20c0 1.5-1 3-2.5 3.5 1.5.6 3-1 3-2.5 0-.6-.2-1-.5-1z" fill="#4fc3f7"/></svg>` },
    { key: 'angry', label: 'Angry', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_angry" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ff6b4a"/><stop offset="1" stop-color="#b81c1c"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_angry)"/><circle cx="14.5" cy="18" r="1.7" fill="#3a0000"/><circle cx="25.5" cy="18" r="1.7" fill="#3a0000"/><path d="M11.5 15l4 2M28.5 15l-4 2" stroke="#3a0000" stroke-width="2" stroke-linecap="round"/><path d="M13 27c2-2 4.5-3 7-3s5 1 7 3" stroke="#3a0000" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>` },
    { key: 'fire', label: 'Fire', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_fire" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffb547"/><stop offset="1" stop-color="#e85a00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_fire)"/><path d="M20 9c1 3 3 4 4 6.5 1 2.5 1 4.5-1 6.5 2 0 4-1 5-3 0 5-3 9-8 9s-8-4-8-8.5c0-2.5 1.5-4.5 3-6 1.5-1.5 2.5-2.5 3-4.5.7.5 1.4 1 2 0z" fill="#fff"/><path d="M20 16c0 2-1 3-1 4.5 0 1.5 1 2.5 1 2.5s1-1 1-2.5c0-1.5-1-2.5-1-4.5z" fill="#ffb547"/></svg>` },
    { key: 'clap', label: 'Clap', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_clap" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#e08a00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_clap)"/><path d="M13 24c0-2 1-3 2.5-3.5.5-2 2-3 3.5-3 0-1.5 1-2.5 2.5-2.5s2.5 1 2.5 2.5c1.5 0 2.5 1.5 2.5 3 .5 0 1.5.5 1.5 2 0 3-2.5 5.5-6 5.5-3.5 0-5-.5-5-.5z" fill="#fff"/><path d="M14 22l1.5-3M17 21l1-3M20 20l1-3" stroke="#e08a00" stroke-width="1.2" stroke-linecap="round"/></svg>` },
    { key: 'star', label: 'Star', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_star" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffe066"/><stop offset="1" stop-color="#d18f00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_star)"/><path d="M20 9l3.4 7 7.6 1.1-5.5 5.4 1.3 7.5L20 26.5l-6.8 3.5 1.3-7.5L9 17.1 16.6 16z" fill="#fff"/></svg>` },
    { key: 'rocket', label: 'Rocket', svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_rocket" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#8b95ff"/><stop offset="1" stop-color="#3a2ba8"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_rocket)"/><path d="M20 8c3 2 5 6 5 10v3h-10v-3c0-4 2-8 5-10z" fill="#fff"/><circle cx="20" cy="16" r="1.8" fill="#3a2ba8"/><path d="M15 21l-2 4 4-1zM25 21l2 4-4-1z" fill="#fff"/><path d="M18 24l-1.5 6c0 .5.5.5.7.2l2.3-3h1l2.3 3c.2.3.7.3.7-.2l-1.5-6z" fill="#ffb547"/></svg>` },
  ];

  function buildReactionsPicker() {
    if (!DOM.reactionsPickerInner) return;
    DOM.reactionsPickerInner.innerHTML = REACTIONS.map((r) => `
      <button class="reaction-emoji" data-key="${r.key}" aria-label="${r.label}" title="${r.label}">
        ${r.svg}
      </button>
    `).join('');
    DOM.reactionsPickerInner.querySelectorAll('.reaction-emoji').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendReaction(btn.dataset.key);
      });
    });
  }

  async function sendReaction(key) {
    if (!currentStream) return;
    if (DOM.reactionsPicker) DOM.re

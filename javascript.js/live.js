// live.js (v19 — Hard-link, dot loading, unique views, auto-poster, better payment flow)
// ════════════════════════════════════════════════════════════
// NEW in v19:
//   • Hard-link support (?stream=<id>) — refresh keeps stream open
//   • Dot loading overlay during access check + payment
//   • Unique view counting (per user via localStorage)
//   • Auto-poster capture (video frame → localStorage cache)
//   • Mode badge (Phone / Video) on live cards
//   • Skeleton loading on initial page load
//   • Smoother payment → stream open flow
// ALL v18 logic preserved 100%
// ════════════════════════════════════════════════════════════
(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const HLS_PATH = '/hls';

  const AKMARK_TOKEN_KEY = 'akmark_token';
  const AKMARK_USER_KEY  = 'akmark_user';
  const PAY_API = `${SUPABASE_URL}/functions/v1/live-check-payments-api`;

  const STREAM_BASE = (function() {
    const h = window.location.hostname;
    if (!h) return 'https://akimark.mw';
    if (h === 'akimark.mw' || h === 'www.akimark.mw') return 'https://akimark.mw';
    if (h.endsWith('.akimark.mw')) return 'https://' + h;
    return 'https://akimark.mw';
  })();

  const POSTER_KEY = 'akimark_poster_v1_';
  const USER_NAME_KEY = 'akimark_display_name';
  const VIEWED_LIVES_KEY = 'akimark_viewed_lives_v1';
  const RECENT_COMMENTS_LIMIT = 10;
  const PRELOAD_POSTERS_MAX = 3;
  const VIEWED_LIVES_MAX = 500;

  // ════════════════════════════════════════════════════════════
  // AUTH HELPERS
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
    try { return localStorage.getItem(USER_NAME_KEY) || 'Guest'; } catch (e) { return 'Guest'; }
  }
  function getAkimarkUserId() {
    const u = getAkimarkUser();
    if (!u) return null;
    return u.user_id || u.id || null;
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
      dotLoadingOverlay: $('dotLoadingOverlay'),
      dotLoadingText: $('dotLoadingText'),
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

  // ════════ DOT LOADING OVERLAY ════════
  function showDotLoading(text) {
    if (!DOM.dotLoadingOverlay) return;
    if (DOM.dotLoadingText) DOM.dotLoadingText.textContent = text || 'Loading…';
    DOM.dotLoadingOverlay.classList.add('show');
  }
  function hideDotLoading() {
    if (!DOM.dotLoadingOverlay) return;
    DOM.dotLoadingOverlay.classList.remove('show');
  }
  function updateDotLoadingText(text) {
    if (DOM.dotLoadingText) DOM.dotLoadingText.textContent = text;
  }

  // ════════ POSTER CACHE ════════
  function getStoredPoster(id) {
    try { return localStorage.getItem(POSTER_KEY + id) || null; } catch (e) { return null; }
  }
  function setStoredPoster(id, url) {
    try { localStorage.setItem(POSTER_KEY + id, url); } catch (e) {}
  }
  function getDisplayName() {
    try { return localStorage.getItem(USER_NAME_KEY) || 'Guest'; } catch (e) { return 'Guest'; }
  }

  // ════════ VIEW TRACKING (unique views) ════════
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
      if (list.includes(liveId)) return false; // already viewed
      list.push(liveId);
      // Keep only last N
      while (list.length > VIEWED_LIVES_MAX) list.shift();
      localStorage.setItem(VIEWED_LIVES_KEY, JSON.stringify(list));
      return true; // new view
    } catch (e) { return false; }
  }

  // ════════ USER BADGE ════════
  function renderUserBadge() {
    if (!DOM.userBadge) return;
    const logged = isAkimarkLoggedIn();
    const user = getAkimarkUser();
    if (logged && user) {
      const name = user.full_name || user.name || 'User';
      const av = initials(name);
      DOM.userBadge.innerHTML = `
        <div class="user-av">${escapeHtmlText(av)}</div>
        <span class="user-name">${escapeHtmlText(name)}</span>
      `;
      DOM.userBadge.classList.add('logged');
      DOM.userBadge.classList.remove('guest');
    } else {
      DOM.userBadge.innerHTML = `
        <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
        <span class="user-name">Guest</span>
      `;
      DOM.userBadge.classList.add('guest');
      DOM.userBadge.classList.remove('logged');
    }
  }

  // ════════ HLS URL BUILDER ════════
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

  // ════════════════════════════════════════════════════════════
  // SKELETON LOADER
  // ════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════
  // LOAD STREAMS
  // ════════════════════════════════════════════════════════════
  async function loadAll() {
    if (!supabase) return;
    // Show skeleton on first load only
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

      initialLoadDone = true;
      renderAll();

      // Auto-capture posters for top 3 streams without a cached poster
      if (!currentStream) {
        liveStreams.slice(0, PRELOAD_POSTERS_MAX).forEach(enqueuePosterCapture);
      }
    } catch (err) {
      console.warn('[live] loadAll error:', err);
      if (!initialLoadDone) {
        // On error, show empty
        initialLoadDone = true;
        renderAll();
      }
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
  }

  function cardHTML(s, isLive) {
    const isFree = s.is_free !== false;
    const priceLabel = isFree ? 'Free' : formatMWK(s.price);
    const priceClass = isFree ? 'free' : 'paid';
    const views = s.views_count || 0;
    const likes = s.likes_count || 0;
    const broadcaster = s.broadcaster_name || 'Akimark';
    const av = initials(broadcaster);
    const cardClass = isLive ? 'is-live' : 'is-ended';
    const badgeClass = isLive ? 'live-badge-card' : 'live-badge-card ended';
    const badgeLabel = isLive ? 'LIVE' : 'ENDED';
    const timeRef = isLive ? (s.actual_start || s.created_at) : (s.actual_end || s.actual_start || s.created_at);
    const timeLabel = isLive ? 'Started ' + formatTime(timeRef) : 'Ended ' + formatTime(timeRef);
    const poster = getStoredPoster(s.id);

    // Mode badge (category-like)
    let modeText = '';
    let modeIcon = '';
    if (s.mode === 'camera') { modeText = 'PHONE'; modeIcon = '📱'; }
    else if (s.mode === 'mp4') { modeText = 'VIDEO'; modeIcon = '🎬'; }
    else { modeText = 'LIVE'; modeIcon = '📡'; }

    return `
      <div class="live-card ${cardClass}" data-id="${s.id}">
        <div class="live-thumb">
          <div class="live-thumb-placeholder"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg></div>
          ${poster ? `<img class="live-thumb-poster ready" src="${poster}" alt="">` : `<img class="live-thumb-poster" data-poster="${s.id}" alt="">`}
          <span class="${badgeClass}">${badgeLabel}</span>
          <span class="live-mode-badge offset">${modeIcon} ${modeText}</span>
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

  // ════════════════════════════════════════════════════════════
  // ACCESS GATE
  // ════════════════════════════════════════════════════════════
  async function checkStreamAccess(stream) {
    if (stream.is_free !== false) return { allowed: true };

    if (!isAkimarkLoggedIn()) {
      return { allowed: false, reason: 'login_required' };
    }

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
        return { allowed: false, reason: 'error', message: data.error || 'Check failed', debug: data.debug };
      }
      if (data.allowed) return { allowed: true, already_paid: data.has_paid };

      return {
        allowed: false,
        reason: 'payment_required',
        price: data.price,
        wallet_balance: data.wallet_balance,
      };
    } catch (e) {
      return { allowed: false, reason: 'error', message: 'Network error' };
    }
  }

  function showLoginPrompt() {
    const overlay = document.createElement('div');
    overlay.className = 'live-gate-overlay';
    overlay.innerHTML = `
      <div class="live-gate-modal">
        <div class="gate-icon"><i style="font-size:1.6rem">🔒</i></div>
        <h3>Login Required</h3>
        <p>Please log in to watch this paid live stream.</p>
        <div class="gate-actions">
          <button class="gate-btn secondary" id="gateCancel">Cancel</button>
          <a class="gate-btn primary" href="/register">Log In</a>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#gateCancel').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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

      const cleanup = (result) => {
        overlay.remove();
        resolve(result);
      };
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
      // Update local user balance
      const user = getAkimarkUser();
      if (user && data.new_balance !== undefined) {
        user.wallet_balance = data.new_balance;
        setAkimarkUser(user);
        renderUserBadge();
      }
      showToast(data.already_paid ? 'Already paid — enjoy!' : (data.message || 'Payment successful!'), { duration: 3200 });
      return true;
    } catch (e) {
      showToast('Network error during payment', { duration: 4000 });
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  // HARD LINK — URL state
  // ════════════════════════════════════════════════════════════
  function getStreamIdFromUrl() {
    try {
      const p = new URLSearchParams(window.location.search);
      return p.get('stream');
    } catch (e) { return null; }
  }
  function setStreamUrl(streamId) {
    try {
      const url = new URL(window.location.href);
      if (streamId) url.searchParams.set('stream', streamId);
      else url.searchParams.delete('stream');
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // OPEN STREAM — v19 (with dot loading + smooth flow)
  // ════════════════════════════════════════════════════════════
  async function openStream(id, isLive, fromUrl) {
    const list = isLive ? liveStreams : previousStreams;
    const stream = list.find((s) => s.id === id);
    if (!stream) {
      // Maybe stream not loaded yet — try to fetch
      if (!fromUrl) showToast('Stream not found');
      return;
    }

    // Show dot loading while checking
    showDotLoading('Checking access…');

    // ═══ ACCESS GATE ═══
    const access = await checkStreamAccess(stream);

    if (!access.allowed) {
      hideDotLoading();

      if (access.reason === 'login_required') {
        showLoginPrompt();
        return;
      }
      if (access.reason === 'payment_required') {
        const confirmed = await showPaymentPrompt(stream, access.price, access.wallet_balance);
        if (!confirmed) return;

        showDotLoading('Processing payment…');
        const paid = await payForLive(stream);
        if (!paid) {
          hideDotLoading();
          return;
        }
        updateDotLoadingText('Opening stream…');
      } else {
        showToast(access.message || 'Access denied', { duration: 3500 });
        return;
      }
    }

    // Small delay for smoothness
    updateDotLoadingText('Opening stream…');

    // Reset state
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

    // Update URL (hard link)
    if (!fromUrl) setStreamUrl(stream.id);

    // Paint UI
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

    if (DOM.modalCommentList) DOM.modalCommentList.innerHTML = '';
    if (DOM.reactionLayer) DOM.reactionLayer.innerHTML = '';
    if (DOM.commentInput) DOM.commentInput.value = '';
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');

    const cachedPoster = getStoredPoster(stream.id);
    if (DOM.streamVideo) {
      try {
        if (cachedPoster) DOM.streamVideo.poster = cachedPoster;
        else DOM.streamVideo.removeAttribute('poster');
      } catch (e) {}
    }

    if (DOM.streamModal) DOM.streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    showControls(true);

    if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = '';
    if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
    hideBuffering();

    retryCount = 0;
    attachHls(stream, isLive);

    // ═══ UNIQUE VIEW COUNT ═══
    if (isLive) {
      const isNew = markLiveViewed(stream.id);
      if (isNew) incrementView(stream.id);
    }

    startStatsPolling(stream.id, isLive);
    prefetchComments(stream.id);

    // Hide dot loading after modal is visible
    setTimeout(hideDotLoading, 250);
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
    // Remove ?stream= from URL
    setStreamUrl(null);
  }

  // ════════════════════════════════════════════════════════════
  // ATTACH HLS — v17 logic (unchanged)
  // ════════════════════════════════════════════════════════════
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
      if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
      showToast('Stream unavailable');
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
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream unavailable';
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
            setTimeout(() => {
              try { hls.startLoad(); } catch (e) {}
            }, 1000);
          }
          return;
        }

        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
          return;
        }

        stallDisabled = true;
        if (!hasStartedPlayback) {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = isLive ? 'Stream ended' : 'Replay unavailable';
        }
      });

      const onFirstPlay = () => {
        if (hasStartedPlayback) return;
        hasStartedPlayback = true;
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        hideBuffering();
        hideDotLoading();

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
        if (!DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2) {
          hideBuffering();
        }
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
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        DOM.streamVideo.play().catch(() => {
          DOM.streamVideo.muted = true;
          DOM.streamVideo.play().catch(() => {});
        });
        if (!hasStartedPlayback) {
          hasStartedPlayback = true;
          hideDotLoading();
          if (!posterCaptured) {
            posterCaptured = true;
            setTimeout(() => capturePoster(stream.id), 1500);
          }
          showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
        }
      }, { once: true });
    } else {
      if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Playback not supported';
      hideDotLoading();
    }
  }

  function showBuffering() { if (DOM.bufferingIndicator) DOM.bufferingIndicator.classList.add('show'); }
  function hideBuffering() { if (DOM.bufferingIndicator) DOM.bufferingIndicator.classList.remove('show'); }
  function scheduleHideBuffering(ms) {
    if (bufferingTimer) clearTimeout(bufferingTimer);
    bufferingTimer = setTimeout(() => hideBuffering(), ms);
  }

  // ════════════════════════════════════════════════════════════
  // POSTER CAPTURE (from video frame)
  // ════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════
  // BACKGROUND POSTER QUEUE
  // ════════════════════════════════════════════════════════════
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
        hlsBg = new window.Hls({
          lowLatencyMode: false,
          maxBufferLength: 8,
          maxMaxBufferLength: 12,
          enableWorker: true,
          startLevel: -1,
        });
        hlsBg.on(window.Hls.Events.ERROR, (_e, d) => {
          if (d.fatal) { clearTimeout(failTimer); cleanup(); }
        });
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

  // ════════════════════════════════════════════════════════════
  // VIEW INCREMENT (unique)
  // ════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════
  // STATS POLLING
  // ════════════════════════════════════════════════════════════
  function startStatsPolling(liveId, isLive) {
    stopStatsPolling();
    fetchStats(liveId, isLive);
    statsPollTimer = setInterval(() => fetchStats(liveId, isLive), 5000);
  }
  function stopStatsPolling() {
    if (statsPollTimer) { clear

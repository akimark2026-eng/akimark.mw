// live.js (v24 — Pro Cache-First + Realtime Primary + Zero login-checker)
// Upgrades vs v23:
//  - liveStreams cache 60s (localStorage) — zero-block init.
//  - paidLiveIds cache 5min (sessionStorage, per-token) — 0 calls when cached.
//  - Polling: 20s → 120s (realtime primary, polling fallback).
//  - Realtime debounce 2s (batches events).
//  - Stats polling: 5s → 10s.
//  - Skip polling when tab hidden; refresh on tab return if stale.
//  - getAkimarkToken checks localStorage + sessionStorage + cookie.
//  - Global 401 handler on PAY_API → redirect to login.
//  - incrementView: single call (no SELECT round-trip).
//  - window.LiveRefresh() public API.

(function() {
  'use strict';

  var SUPABASE_URL = window.SUPABASE_URL;
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  var HLS_PATH = '/hls';

  var AKMARK_TOKEN_KEY = 'akmark_token';
  var AKMARK_USER_KEY  = 'akmark_user';
  var LOGIN_URL = '/login.html';
  var PAY_API = SUPABASE_URL + '/functions/v1/live-check-payments-api';

  // ════════════════════════════════════════════════════════════
  // 🎯 CACHE CONFIG
  // ════════════════════════════════════════════════════════════
  var CACHE_LIVES_KEY     = 'akmark_cache_lives_v1';
  var CACHE_PAID_PREFIX   = 'akmark_cache_paid_lives_';
  var TTL_LIVES           = 60 * 1000;        // 60s
  var TTL_PAID_IDS        = 5 * 60 * 1000;    // 5 min
  var REALTIME_DEBOUNCE_MS = 2000;
  var LIVES_POLL_MS       = 120 * 1000;       // 2 min
  var STATS_POLL_MS       = 10 * 1000;        // 10s

  var STREAM_BASE = (function() {
    var h = window.location.hostname;
    if (!h) return 'https://akimark.mw';
    if (h === 'akimark.mw' || h === 'www.akimark.mw') return 'https://akimark.mw';
    if (h.endsWith('.akimark.mw')) return 'https://' + h;
    return 'https://akimark.mw';
  })();

  var POSTER_KEY = 'akimark_poster_v1_';
  var VIEWED_LIVES_KEY = 'akimark_viewed_lives_v1';
  var VIEWED_LIVES_MAX = 500;
  var LOAD_TIMEOUT_MS = 8000;

  // ════════════════════════════════════════════════════════════
  // AUTH — LOCAL ONLY (no network, no login-checker)
  // ════════════════════════════════════════════════════════════
  function getAkimarkToken() {
    var token = null;
    try { token = localStorage.getItem(AKMARK_TOKEN_KEY); } catch (e) {}
    if (!token) { try { token = sessionStorage.getItem(AKMARK_TOKEN_KEY); } catch (e) {} }
    if (!token) {
      try {
        var cookies = document.cookie.split(';');
        for (var i = 0; i < cookies.length; i++) {
          var c = cookies[i].trim();
          if (c.indexOf(AKMARK_TOKEN_KEY + '=') === 0) {
            token = c.substring(AKMARK_TOKEN_KEY.length + 1);
            break;
          }
        }
      } catch (e) {}
    }
    if (!token || token === 'null' || token === 'undefined') return null;
    try {
      var parsed = JSON.parse(token);
      if (parsed && parsed.access_token) return parsed.access_token;
      if (typeof parsed === 'string') return parsed;
    } catch (e) {}
    return String(token).replace(/^["']|["']$/g, '').trim();
  }
  function getAkimarkUser() {
    try {
      var raw = localStorage.getItem(AKMARK_USER_KEY);
      if (!raw) return null;
      var u = JSON.parse(raw);
      if (!u || typeof u !== 'object') return null;
      return u;
    } catch (e) { return null; }
  }
  function setAkimarkUser(user) {
    try { localStorage.setItem(AKMARK_USER_KEY, JSON.stringify(user)); } catch (e) {}
  }
  function setTokenInAllPlaces(token) {
    try { localStorage.setItem(AKMARK_TOKEN_KEY, token); } catch (e) {}
    try { sessionStorage.setItem(AKMARK_TOKEN_KEY, token); } catch (e) {}
    try {
      var expires = new Date();
      expires.setTime(expires.getTime() + 7 * 24 * 60 * 60 * 1000);
      document.cookie = AKMARK_TOKEN_KEY + '=' + token + '; expires=' + expires.toUTCString() + '; path=/; SameSite=Lax';
    } catch (e) {}
  }
  function eraseCookie(name) {
    try { document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;'; } catch (e) {}
  }
  function isAkimarkLoggedIn() { return !!getAkimarkToken(); }
  function getAkimarkDisplayName() {
    var u = getAkimarkUser();
    if (u && (u.full_name || u.name)) return u.full_name || u.name;
    return 'User';
  }
  function getAkimarkUserId() {
    var u = getAkimarkUser();
    if (!u) return null;
    return u.user_id || u.id || null;
  }
  function clearSession() {
    var token = getAkimarkToken();
    try {
      localStorage.removeItem(AKMARK_TOKEN_KEY);
      sessionStorage.removeItem(AKMARK_TOKEN_KEY);
      localStorage.removeItem('akmark_refresh_token');
      sessionStorage.removeItem('akmark_refresh_token');
      localStorage.removeItem(AKMARK_USER_KEY);
    } catch (e) {}
    eraseCookie(AKMARK_TOKEN_KEY);
    eraseCookie('akmark_user_logged');

    if (token) {
      try { sessionStorage.removeItem(CACHE_PAID_PREFIX + token); } catch (e) {}
    }
    paidLiveIds = new Set();
  }
  function handleAuthError(status) {
    if (status === 401 || status === 403) {
      clearSession();
      window.location.replace(LOGIN_URL);
      return true;
    }
    return false;
  }
  function enforceLogin() {
    if (!isAkimarkLoggedIn()) {
      try {
        var next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.replace(LOGIN_URL + '?next=' + next);
      } catch (e) {
        window.location.replace(LOGIN_URL);
      }
      return false;
    }
    return true;
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 CACHE HELPERS
  // ════════════════════════════════════════════════════════════
  function cacheReadLives() {
    try {
      var raw = localStorage.getItem(CACHE_LIVES_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return { data: parsed.data, age: Date.now() - parsed.ts };
    } catch (e) { return null; }
  }
  function cacheWriteLives(lives) {
    try {
      localStorage.setItem(CACHE_LIVES_KEY, JSON.stringify({ ts: Date.now(), data: lives }));
    } catch (e) {}
  }
  function cacheReadPaidIds(token) {
    try {
      var raw = sessionStorage.getItem(CACHE_PAID_PREFIX + token);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > TTL_PAID_IDS) return null;
      return parsed.data;
    } catch (e) { return null; }
  }
  function cacheWritePaidIds(token, ids) {
    try {
      sessionStorage.setItem(CACHE_PAID_PREFIX + token, JSON.stringify({ ts: Date.now(), data: ids }));
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 SUPABASE CLIENT
  // ════════════════════════════════════════════════════════════
  var supabase = null;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && typeof window.supabase.createClient === 'function') {
    try { supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 STATE
  // ════════════════════════════════════════════════════════════
  var liveStreams = [];
  var currentStream = null;
  var currentIsLive = false;
  var hls = null;
  var statsPollTimer = null;
  var loadTimer = null;
  var retryTimer = null;
  var retryCount = 0;
  var watchdogTimer = null;
  var bufferingTimer = null;
  var posterCaptured = false;
  var controlsHideTimer = null;
  var controlsVisible = true;
  var hasStartedPlayback = false;
  var lastProgressAt = 0;
  var stallDisabled = false;
  var recoveryAttempts = 0;
  var userLiked = false;
  var initialLoadDone = false;
  var loadTimeoutHandle = null;
  var paidLiveIds = new Set();
  var paidLiveIdsLoaded = false;
  var currentProgress = 0;
  var progressSimTimer = null;
  var realtimeDebounce = null;
  var realtimeChannel = null;
  var appInited = false;

  // ════════════════════════════════════════════════════════════
  // 🎯 DOM
  // ════════════════════════════════════════════════════════════
  var $ = function(id) { return document.getElementById(id); };
  var DOM = {};

  function bindDom() {
    DOM = {
      liveGrid: $('liveGrid'), liveCount: $('liveCount'), emptyState: $('emptyState'),
      navLiveBadge: $('navLiveBadge'), toast: $('toast'), toastMsg: $('toastMsg'),
      streamModal: $('streamModal'), streamStage: $('streamStage'),
      streamClose: $('streamClose'), streamVideo: $('streamVideo'),
      videoLoader: $('videoLoader'), videoLoaderText: $('videoLoaderText'),
      bufferingIndicator: $('bufferingIndicator'),
      streamModalLabel: $('streamModalLabel'), modalTitle: $('modalTitle'),
      modalBroadcaster: $('modalBroadcaster'), modalViews: $('modalViews'),
      reactionLayer: $('reactionLayer'),
      likeBtn: $('likeBtn'), likeCount: $('likeCount'),
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
      progressBarFill: $('progressBarFill'),
      progressBarPercent: $('progressBarPercent'),
      gifProgressBarFill: $('gifProgressBarFill'),
      gifProgressBarPercent: $('gifProgressBarPercent'),
      liveWatermark: $('liveWatermark'),
    };
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 UTILS
  // ════════════════════════════════════════════════════════════
  function escapeHtmlText(str) {
    return String(str || '').replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function formatTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      var diff = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return d.getDate() + ' ' + m[d.getMonth()];
    } catch (e) { return '—'; }
  }
  function formatMWK(n) { return 'MWK ' + Number(n || 0).toLocaleString(); }
  function initials(name) {
    var n = (name || 'A').trim();
    var parts = n.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  function showToast(msg, opts) {
    if (!DOM.toast || !DOM.toastMsg) return;
    DOM.toastMsg.textContent = msg;
    DOM.toast.classList.toggle('welcome', !!(opts && opts.welcome));
    DOM.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function() {
      DOM.toast.classList.remove('show');
      DOM.toast.classList.remove('welcome');
    }, (opts && opts.duration) ? opts.duration : 2600);
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 PROGRESS BAR
  // ════════════════════════════════════════════════════════════
  function setProgress(pct, target) {
    var fill = target === 'gif' ? DOM.gifProgressBarFill : DOM.progressBarFill;
    var label = target === 'gif' ? DOM.gifProgressBarPercent : DOM.progressBarPercent;
    currentProgress = Math.min(100, Math.max(0, Math.round(pct)));
    if (fill) fill.style.width = currentProgress + '%';
    if (label) label.textContent = currentProgress + '%';
  }
  function bumpProgress(to, target) { if (to > currentProgress) setProgress(to, target); }
  function simulateProgress(targetPct, target, durationMs) {
    var startPct = currentProgress;
    var delta = targetPct - startPct;
    if (delta <= 0) return;
    var startTime = Date.now();
    if (progressSimTimer) clearInterval(progressSimTimer);
    progressSimTimer = setInterval(function() {
      var elapsed = Date.now() - startTime;
      var ratio = Math.min(1, elapsed / durationMs);
      var eased = 1 - Math.pow(1 - ratio, 3);
      setProgress(startPct + delta * eased, target);
      if (ratio >= 1) { clearInterval(progressSimTimer); progressSimTimer = null; }
    }, 60);
  }
  function resetProgress(target) {
    currentProgress = 0;
    setProgress(0, target);
    if (progressSimTimer) { clearInterval(progressSimTimer); progressSimTimer = null; }
  }

  function showGifLoading(text) {
    if (!DOM.gifLoadingOverlay) return;
    if (DOM.gifLoadingText) DOM.gifLoadingText.textContent = text || 'Loading…';
    DOM.gifLoadingOverlay.classList.add('show');
    resetProgress('gif');
    simulateProgress(70, 'gif', 1800);
  }
  function hideGifLoading() {
    if (!DOM.gifLoadingOverlay) return;
    setProgress(100, 'gif');
    setTimeout(function() {
      DOM.gifLoadingOverlay.classList.remove('show');
      resetProgress('gif');
    }, 200);
  }
  function updateGifLoadingText(text) { if (DOM.gifLoadingText) DOM.gifLoadingText.textContent = text; }

  function getViewedLives() {
    try {
      var raw = localStorage.getItem(VIEWED_LIVES_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function markLiveViewed(liveId) {
    try {
      var list = getViewedLives();
      if (list.indexOf(liveId) !== -1) return false;
      list.push(liveId);
      while (list.length > VIEWED_LIVES_MAX) list.shift();
      localStorage.setItem(VIEWED_LIVES_KEY, JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }

  function renderUserBadge() {
    if (!DOM.userBadge) return;
    var user = getAkimarkUser();
    var name = (user && (user.full_name || user.name || user.email)) || 'User';
    if (DOM.userBadgeAv) DOM.userBadgeAv.textContent = initials(name);
    if (DOM.userBadgeName) DOM.userBadgeName.textContent = name;
    DOM.userBadge.style.display = 'inline-flex';
  }

  function buildHlsUrl(stream) {
    var url = stream.hls_url;
    if (!url && stream.stream_key) {
      url = stream.mode === 'camera'
        ? HLS_PATH + '/live/' + stream.stream_key + '/index.m3u8'
        : HLS_PATH + '/' + stream.stream_key + '/index.m3u8';
    }
    if (!url) return null;
    if (url.charAt(0) === '/') return STREAM_BASE + url;
    try {
      var u = new URL(url);
      if (u.hostname.endsWith('.akimark.mw') || u.hostname === 'akimark.mw') {
        return STREAM_BASE + u.pathname + u.search;
      }
    } catch (e) {
      return STREAM_BASE + '/' + url.replace(/^\/+/, '');
    }
    return url;
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 LOAD PAID IDS (CACHED)
  // ════════════════════════════════════════════════════════════
  async function loadPaidLiveIds() {
    if (!supabase) return;
    var userId = getAkimarkUserId();
    if (!userId) return;

    // Skip if all streams are free
    var hasPaid = liveStreams.some(function(s) { return s.is_free === false; });
    if (!hasPaid && paidLiveIdsLoaded) return;

    var token = getAkimarkToken();
    if (!token) return;

    var cached = cacheReadPaidIds(token);
    if (cached) {
      paidLiveIds = new Set(cached);
      paidLiveIdsLoaded = true;
      return;
    }

    try {
      var res = await supabase
        .from('live_payments')
        .select('live_id')
        .eq('user_id', userId)
        .eq('status', 'success');

      if (res.error) {
        var msg = (res.error.message || '').toLowerCase();
        if (msg.indexOf('jwt') !== -1 || res.error.code === 'PGRST301') {
          handleAuthError(401);
          return;
        }
        return;
      }

      paidLiveIds = new Set((res.data || []).map(function(r) { return r.live_id; }));
      cacheWritePaidIds(token, Array.from(paidLiveIds));
      paidLiveIdsLoaded = true;
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 SKELETON
  // ════════════════════════════════════════════════════════════
  function renderSkeletons() {
    if (!DOM.liveGrid) return;
    var sk = '';
    for (var i = 0; i < 3; i++) {
      sk += '<div class="skeleton-card">' +
        '<div class="skeleton-thumb"></div>' +
        '<div class="skeleton-body">' +
          '<div class="skeleton-line w-80"></div>' +
          '<div class="skeleton-line w-50"></div>' +
          '<div class="skeleton-line w-30"></div>' +
        '</div>' +
      '</div>';
    }
    DOM.liveGrid.innerHTML = sk;
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 LOAD STREAMS (CACHE-FIRST)
  // ════════════════════════════════════════════════════════════
  async function refreshStreamsFromServer() {
    try {
      var liveRes = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,webrtc_url,is_active,actual_start,created_at,broadcaster_name,views_count,likes_count,is_free,price,admin_id,poster_url', { count: 'exact' })
        .eq('status', 'live').eq('is_active', true)
        .order('actual_start', { ascending: false }).limit(50);

      if (liveRes.error) {
        var msg = (liveRes.error.message || '').toLowerCase();
        if (msg.indexOf('jwt') !== -1 || liveRes.error.code === 'PGRST301') {
          handleAuthError(401);
          return;
        }
        throw liveRes.error;
      }

      liveStreams = liveRes.data || [];
      cacheWriteLives(liveStreams);
      await loadPaidLiveIds();
      renderAll();
    } catch (err) {
      console.warn('Stream refresh failed:', err);
    }
  }

  async function loadAll(forceRefresh) {
    if (!supabase) {
      initialLoadDone = true;
      renderAll();
      return;
    }

    var cached = forceRefresh ? null : cacheReadLives();

    if (cached && cached.age < TTL_LIVES) {
      // Fresh cache — 0 network
      liveStreams = cached.data;
      if (!initialLoadDone) {
        initialLoadDone = true;
        if (loadTimeoutHandle) { clearTimeout(loadTimeoutHandle); loadTimeoutHandle = null; }
        renderAll();
      }
      // Still load paid IDs (cached internally)
      loadPaidLiveIds();
      return;
    }

    if (cached) {
      // Stale cache — render then SWR refresh
      liveStreams = cached.data;
      if (!initialLoadDone) {
        initialLoadDone = true;
        if (loadTimeoutHandle) { clearTimeout(loadTimeoutHandle); loadTimeoutHandle = null; }
        renderAll();
      }
      refreshStreamsFromServer();
      return;
    }

    // No cache — blocking fetch with skeleton
    if (!initialLoadDone) renderSkeletons();
    await refreshStreamsFromServer();
    initialLoadDone = true;
    if (loadTimeoutHandle) { clearTimeout(loadTimeoutHandle); loadTimeoutHandle = null; }
    renderAll();
  }

  function renderAll() {
    if (DOM.liveCount) DOM.liveCount.textContent = liveStreams.length;
    if (liveStreams.length > 0) {
      if (DOM.navLiveBadge) DOM.navLiveBadge.classList.remove('off');
      document.title = 'LIVE (' + liveStreams.length + ') | Akimark';
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
      DOM.liveGrid.innerHTML = liveStreams.map(function(s) { return cardHTML(s, true); }).join('');
      var cards = DOM.liveGrid.querySelectorAll('.live-card');
      for (var i = 0; i < cards.length; i++) {
        (function(el) {
          el.addEventListener('click', function() { openStream(el.dataset.id, true); });
        })(cards[i]);
      }
    }

    var urlStreamId = getStreamIdFromUrl();
    if (urlStreamId && !currentStream) {
      var inLive = null;
      for (var j = 0; j < liveStreams.length; j++) {
        if (liveStreams[j].id === urlStreamId) { inLive = liveStreams[j]; break; }
      }
      if (inLive) setTimeout(function() { openStream(urlStreamId, true, true); }, 200);
    }
  }

  function cardHTML(s, isLive) {
    var isFree = s.is_free !== false;
    var userHasPaid = !isFree && paidLiveIds.has(s.id);
    var priceLabel = isFree ? 'Free' : (userHasPaid ? 'Unlocked' : formatMWK(s.price));
    var priceClass = isFree ? 'free' : (userHasPaid ? 'unlocked' : 'paid');
    var views = s.views_count || 0;
    var likes = s.likes_count || 0;
    var broadcaster = s.broadcaster_name || 'Akimark';
    var av = initials(broadcaster);
    var cardClass = 'is-live';
    var badgeClass = 'live-badge-card';
    var badgeLabel = 'LIVE';
    var timeRef = s.actual_start || s.created_at;
    var timeLabel = 'Started ' + formatTime(timeRef);
    var poster = s.poster_url || '';
    var paidBadge = userHasPaid ? '<span class="live-paid-badge">✓ Paid</span>' : '';

    return '<div class="live-card ' + cardClass + '" data-id="' + escapeHtmlText(s.id) + '">' +
      '<div class="live-thumb">' +
        '<div class="live-thumb-placeholder"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg></div>' +
        (poster ? '<img class="live-thumb-poster ready" src="' + escapeHtmlText(poster) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
        '<span class="' + badgeClass + '">' + badgeLabel + '</span>' +
        paidBadge +
        '<span class="live-viewers"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' + views + '</span>' +
        '<span class="live-price ' + priceClass + '">' + escapeHtmlText(priceLabel) + '</span>' +
      '</div>' +
      '<div class="live-info">' +
        '<div class="live-title">' + escapeHtmlText(s.title || 'Live Stream') + '</div>' +
        '<div class="live-broadcaster"><div class="avatar">' + escapeHtmlText(av) + '</div><span>' + escapeHtmlText(broadcaster) + '</span></div>' +
        '<div class="live-stats-row">' +
          '<span><svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>' + likes + '</span>' +
          '<span style="margin-left:auto;">' + timeLabel + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 ACCESS GATE
  // ════════════════════════════════════════════════════════════
  async function checkStreamAccess(stream) {
    if (stream.is_free !== false) return { allowed: true };
    if (paidLiveIds.has(stream.id)) return { allowed: true, already_paid: true };

    try {
      var res = await fetch(PAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getAkimarkToken(),
        },
        body: JSON.stringify({ action: 'check_payment', live_id: stream.id }),
      });

      if (handleAuthError(res.status)) {
        return { allowed: false, reason: 'auth' };
      }

      var data = await res.json();
      if (!res.ok || !data.success) {
        return { allowed: false, reason: 'error', message: data.error || 'Check failed' };
      }
      if (data.allowed) {
        if (data.has_paid) {
          paidLiveIds.add(stream.id);
          var token = getAkimarkToken();
          if (token) cacheWritePaidIds(token, Array.from(paidLiveIds));
        }
        return { allowed: true, already_paid: data.has_paid };
      }
      return { allowed: false, reason: 'payment_required', price: data.price, wallet_balance: data.wallet_balance };
    } catch (e) {
      return { allowed: false, reason: 'error', message: 'Network error' };
    }
  }

  function showPaymentPrompt(stream, price, walletBalance) {
    return new Promise(function(resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'live-gate-overlay';
      overlay.innerHTML = '<div class="live-gate-modal">' +
        '<div class="gate-icon paid"><span style="font-size:1.6rem">💰</span></div>' +
        '<h3>Paid Live Stream</h3>' +
        '<p class="gate-sub">' + escapeHtmlText(stream.title || 'Live Stream') + '</p>' +
        '<div class="gate-price-row"><span>Price</span><strong>' + formatMWK(price) + '</strong></div>' +
        '<div class="gate-price-row"><span>Your Balance</span><strong class="' + (walletBalance >= price ? 'ok' : 'low') + '">' + formatMWK(walletBalance) + '</strong></div>' +
        (walletBalance < price ? '<div class="gate-warn"><span>⚠️</span>Insufficient balance. Please top up your wallet.</div>' : '') +
        '<div class="gate-actions">' +
          '<button class="gate-btn secondary" id="gateCancel">Cancel</button>' +
          (walletBalance >= price
            ? '<button class="gate-btn primary" id="gateConfirm">Pay & Watch</button>'
            : '<a class="gate-btn primary" href="/deposit">Top Up</a>') +
        '</div>' +
      '</div>';
      document.body.appendChild(overlay);

      var cleanup = function(result) { overlay.remove(); resolve(result); };
      overlay.querySelector('#gateCancel').onclick = function() { cleanup(false); };
      var confirmBtn = overlay.querySelector('#gateConfirm');
      if (confirmBtn) confirmBtn.onclick = function() { cleanup(true); };
      overlay.addEventListener('click', function(e) { if (e.target === overlay) cleanup(false); });
    });
  }

  async function payForLive(stream) {
    try {
      var res = await fetch(PAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getAkimarkToken(),
        },
        body: JSON.stringify({ action: 'pay_and_watch', live_id: stream.id }),
      });

      if (handleAuthError(res.status)) return false;

      var data = await res.json();
      if (!res.ok || !data.success) {
        showToast(data.message || data.error || 'Payment failed', { duration: 4000 });
        return false;
      }

      var user = getAkimarkUser();
      if (user && data.new_balance !== undefined) {
        user.wallet_balance = data.new_balance;
        setAkimarkUser(user);
      }
      paidLiveIds.add(stream.id);

      // Update paid-IDs cache
      var token = getAkimarkToken();
      if (token) cacheWritePaidIds(token, Array.from(paidLiveIds));

      showToast(data.already_paid ? 'Already paid — enjoy!' : 'Payment successful!', { duration: 3000 });
      return true;
    } catch (e) {
      showToast('Network error during payment', { duration: 4000 });
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 URL / HARD LINK
  // ════════════════════════════════════════════════════════════
  function getStreamIdFromUrl() {
    try { return new URLSearchParams(window.location.search).get('stream'); } catch (e) { return null; }
  }
  function setStreamUrl(streamId) {
    try {
      var url = new URL(window.location.href);
      if (streamId) url.searchParams.set('stream', streamId);
      else url.searchParams.delete('stream');
      window.history.replaceState({}, '', url.toString());
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 OPEN STREAM
  // ════════════════════════════════════════════════════════════
  async function openStream(id, isLive, fromUrl) {
    var stream = null;
    for (var i = 0; i < liveStreams.length; i++) {
      if (liveStreams[i].id === id) { stream = liveStreams[i]; break; }
    }
    if (!stream) {
      if (!fromUrl) showToast('Stream not found');
      return;
    }

    showGifLoading('Checking access…');
    var access = await checkStreamAccess(stream);

    if (!access.allowed) {
      hideGifLoading();
      if (access.reason === 'payment_required') {
        var confirmed = await showPaymentPrompt(stream, access.price, access.wallet_balance);
        if (!confirmed) return;
        showGifLoading('Processing payment…');
        var paid = await payForLive(stream);
        if (!paid) { hideGifLoading(); return; }
        updateGifLoadingText('Opening stream…');
      } else {
        showToast(access.message || 'Access denied', { duration: 3500 });
        return;
      }
    }

    updateGifLoadingText('Opening stream…');

    currentStream = stream;
    currentIsLive = true;
    posterCaptured = false;
    hasStartedPlayback = false;
    stallDisabled = false;
    recoveryAttempts = 0;
    lastProgressAt = Date.now();
    userLiked = false;

    if (!fromUrl) setStreamUrl(stream.id);

    if (DOM.modalTitle) DOM.modalTitle.textContent = stream.title || 'Live Stream';
    var broadcaster = stream.broadcaster_name || 'Akimark';
    if (DOM.modalBroadcaster) DOM.modalBroadcaster.textContent = broadcaster;
    if (DOM.modalViews) DOM.modalViews.textContent = stream.views_count || 0;
    if (DOM.likeCount) DOM.likeCount.textContent = stream.likes_count || 0;
    if (DOM.likeBtn) DOM.likeBtn.classList.remove('liked');

    if (DOM.streamModalLabel) {
      DOM.streamModalLabel.textContent = 'LIVE';
      DOM.streamModalLabel.classList.remove('ended');
    }

    if (DOM.reactionLayer) DOM.reactionLayer.innerHTML = '';
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');

    if (DOM.streamVideo) {
      try { DOM.streamVideo.removeAttribute('poster'); } catch (e) {}
    }

    if (DOM.streamModal) DOM.streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    showControls(true);

    if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Connecting…';
    if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
    hideBuffering();

    resetProgress('video');
    simulateProgress(20, 'video', 1200);

    retryCount = 0;
    attachHls(stream, true);

    var isNew = markLiveViewed(stream.id);
    if (isNew) incrementView(stream.id);

    startStatsPolling(stream.id, true);
    setTimeout(hideGifLoading, 250);
  }

  function closeStream() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
    if (progressSimTimer) { clearInterval(progressSimTimer); progressSimTimer = null; }
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
    currentStream = null;
    currentIsLive = false;
    hasStartedPlayback = false;
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');
    setStreamUrl(null);
    resetProgress('video');
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 HLS ATTACH
  // ════════════════════════════════════════════════════════════
  async function attachHls(stream, isLive) {
    var hlsUrl = buildHlsUrl(stream);

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
      hideGifLoading();
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 40,
        maxMaxBufferLength: 90,
        maxBufferSize: 90 * 1000 * 1000,
        maxBufferHole: 1.0,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 12,
        highBufferWatchdogPeriod: 2,
        abrEwmaDefaultEstimate: 800000,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.75,
        startLevel: -1,
        fragLoadingMaxRetry: 8,
        fragLoadingMaxRetryTimeout: 32000,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 5,
        enableWorker: true,
        xhrSetup: function(xhr) { xhr.withCredentials = true; },
      });

      hls.on(window.Hls.Events.MANIFEST_LOADING, function() { bumpProgress(5, 'video'); });
      hls.on(window.Hls.Events.MANIFEST_LOADED, function() { bumpProgress(15, 'video'); });
      hls.on(window.Hls.Events.MANIFEST_PARSED, function() {
        bumpProgress(30, 'video');
        if (DOM.streamVideo) {
          DOM.streamVideo.muted = false;
          DOM.streamVideo.volume = 1;
          var p = DOM.streamVideo.play();
          if (p && p.catch) p.catch(function() {
            DOM.streamVideo.muted = true;
            DOM.streamVideo.play().catch(function() {});
          });
        }
      });
      hls.on(window.Hls.Events.LEVEL_LOADED, function() { bumpProgress(45, 'video'); });
      hls.on(window.Hls.Events.FRAG_LOADED, function() { bumpProgress(60, 'video'); });
      hls.on(window.Hls.Events.FRAG_BUFFERED, function() { bumpProgress(75, 'video'); });

      hls.on(window.Hls.Events.ERROR, function(_evt, data) {
        if (!data.fatal) return;

        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          if (data.details === 'manifestLoadError' || data.details === 'manifestLoadTimeOut') {
            retryCount++;
            if (retryCount <= 20) {
              if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Connecting…';
              if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
              retryTimer = setTimeout(function() { attachHls(stream, isLive); }, 2200);
            } else {
              if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream unavailable';
              hideGifLoading();
            }
            return;
          }

          var playing = DOM.streamVideo && !DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2 && DOM.streamVideo.currentTime > 0;
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
            setTimeout(function() { try { hls.startLoad(); } catch (e) {} }, 1000);
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
          hideGifLoading();
        }
      });

      var onFirstPlay = function() {
        if (hasStartedPlayback) return;
        hasStartedPlayback = true;
        setProgress(100, 'video');
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        hideBuffering();
        hideGifLoading();
        showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
      };

      DOM.streamVideo.addEventListener('playing', onFirstPlay);

      DOM.streamVideo.addEventListener('timeupdate', function() {
        lastProgressAt = Date.now();
        recoveryAttempts = 0;
        if (!hasStartedPlayback) onFirstPlay();
        if (!DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2) hideBuffering();
      });

      DOM.streamVideo.addEventListener('waiting', function() {
        if (hasStartedPlayback && !DOM.streamVideo.paused) showBuffering();
      });

      DOM.streamVideo.addEventListener('canplay', function() {
        bumpProgress(90, 'video');
        hideBuffering();
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(DOM.streamVideo);

      watchdogTimer = setInterval(function() {
        if (!hls || !DOM.streamVideo || !isLive) return;
        if (stallDisabled) return;
        if (!hasStartedPlayback) return;
        if (DOM.streamVideo.paused || DOM.streamVideo.ended) return;

        var timeSinceProgress = Date.now() - lastProgressAt;
        if (timeSinceProgress > 3500) {
          recoveryAttempts++;
          if (recoveryAttempts === 1) {
            try { hls.startLoad(); } catch (e) {}
          } else if (recoveryAttempts <= 3) {
            try {
              var b = DOM.streamVideo.buffered;
              if (b.length > 0) {
                var lastEnd = b.end(b.length - 1);
                if (lastEnd > DOM.streamVideo.currentTime + 0.5) {
                  DOM.streamVideo.currentTime = lastEnd - 0.5;
                  DOM.streamVideo.play().catch(function() {});
                } else {
                  hls.startLoad();
                }
              }
            } catch (e) {}
          } else {
            try {
              var b2 = DOM.streamVideo.buffered;
              if (b2.length > 0) {
                var liveEdge = b2.end(b2.length - 1);
                DOM.streamVideo.currentTime = Math.max(0, liveEdge - 1.5);
                DOM.streamVideo.play().catch(function() {});
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

      DOM.streamVideo.addEventListener('loadstart', function() { bumpProgress(10, 'video'); });
      DOM.streamVideo.addEventListener('loadedmetadata', function() { bumpProgress(35, 'video'); });
      DOM.streamVideo.addEventListener('loadeddata', function() { bumpProgress(55, 'video'); });
      DOM.streamVideo.addEventListener('canplay', function() { bumpProgress(80, 'video'); });

      DOM.streamVideo.addEventListener('loadedmetadata', function() {
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        DOM.streamVideo.play().catch(function() {
          DOM.streamVideo.muted = true;
          DOM.streamVideo.play().catch(function() {});
        });
        if (!hasStartedPlayback) {
          hasStartedPlayback = true;
          setProgress(100, 'video');
          hideGifLoading();
          showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
        }
      }, { once: true });
    } else {
      if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Playback not supported';
      hideGifLoading();
    }
  }

  function showBuffering() { if (DOM.bufferingIndicator) DOM.bufferingIndicator.classList.add('show'); }
  function hideBuffering() { if (DOM.bufferingIndicator) DOM.bufferingIndicator.classList.remove('show'); }
  function scheduleHideBuffering(ms) {
    if (bufferingTimer) clearTimeout(bufferingTimer);
    bufferingTimer = setTimeout(function() { hideBuffering(); }, ms);
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 VIEW INCREMENT (single call — no SELECT)
  // ════════════════════════════════════════════════════════════
  async function incrementView(liveId) {
    try {
      var cur = null;
      for (var i = 0; i < liveStreams.length; i++) {
        if (liveStreams[i].id === liveId) { cur = liveStreams[i]; break; }
      }
      var next = ((cur && cur.views_count) || 0) + 1;
      await supabase.from('live_videos').update({ views_count: next }).eq('id', liveId);
      if (cur) cur.views_count = next;
      if (currentStream && currentStream.id === liveId) {
        currentStream.views_count = next;
        if (DOM.modalViews) DOM.modalViews.textContent = next;
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 STATS POLLING (10s, only when modal open)
  // ════════════════════════════════════════════════════════════
  function startStatsPolling(liveId, isLive) {
    stopStatsPolling();
    fetchStats(liveId, isLive);
    statsPollTimer = setInterval(function() { fetchStats(liveId, isLive); }, STATS_POLL_MS);
  }
  function stopStatsPolling() {
    if (statsPollTimer) { clearInterval(statsPollTimer); statsPollTimer = null; }
  }

  async function fetchStats(liveId, isLive) {
    try {
      var result = await supabase
        .from('live_videos').select('views_count,likes_count,status,is_active')
        .eq('id', liveId).maybeSingle();
      var live = result.data;
      if (!live) return;

      if (DOM.modalViews) DOM.modalViews.textContent = live.views_count || 0;
      if (DOM.likeCount && !userLiked) DOM.likeCount.textContent = live.likes_count || 0;
      if (currentStream) {
        currentStream.views_count = live.views_count || 0;
        if (!userLiked) currentStream.likes_count = live.likes_count || 0;
      }

      if (isLive && (live.status !== 'live' || live.is_active === false)) {
        if (DOM.streamModalLabel) {
          DOM.streamModalLabel.textContent = 'ENDED';
          DOM.streamModalLabel.classList.add('ended');
        }
        if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        stopStatsPolling();
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 LIKE / REACTIONS
  // ════════════════════════════════════════════════════════════
  var likeInFlight = false;

  async function toggleLike() {
    if (!currentStream || likeInFlight) return;
    likeInFlight = true;

    var alreadyLiked = DOM.likeBtn && DOM.likeBtn.classList.contains('liked');
    var delta = alreadyLiked ? -1 : 1;
    var newCount = Math.max(0, (currentStream.likes_count || 0) + delta);

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

  var HEART_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#c71515"/></linearGradient></defs><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" fill="url(#hg)"/></svg>';

  function spawnHeart() {
    if (!DOM.reactionLayer) return;
    var el = document.createElement('div');
    el.className = 'float-heart';
    el.innerHTML = HEART_SVG;
    el.style.left = (40 + Math.random() * 60) + 'px';
    el.style.bottom = '120px';
    el.style.transform = 'translateX(' + ((Math.random() - 0.5) * 40) + 'px)';
    DOM.reactionLayer.appendChild(el);
    setTimeout(function() { try { el.remove(); } catch (e) {} }, 2400);
  }

  var REACTIONS = [
    { key: 'like', label: 'Like', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_like" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#5eb1ff"/><stop offset="1" stop-color="#0d6efd"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_like)"/><path d="M28 18h-4.2v-4.4c0-1.1-.6-1.8-1.7-1.8h-1.6c-.6 0-1.1.5-1.2 1.1l-.5 3.2c-.1.6-.5 1-1.1 1.3l-3.9 1.9h-.9c-.6 0-1.1.5-1.1 1.1v6.1c0 .6.5 1.1 1.1 1.1h9.6c.7 0 1.3-.5 1.4-1.2l1.5-5.2c.2-.6.1-1.3-.2-1.8-.3-.5-.8-.8-1.4-.8z" fill="#fff"/></svg>' },
    { key: 'love', label: 'Love', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_love" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ff6b8a"/><stop offset="1" stop-color="#e0245e"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_love)"/><path d="M20 28s-8-5-8-11.2c0-2.8 2.2-5 5-5 1.7 0 3.2.8 4 2.1.8-1.3 2.3-2.1 4-2.1 2.8 0 5 2.2 5 5C30 23 20 28 20 28z" fill="#fff"/></svg>' },
    { key: 'haha', label: 'Haha', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_haha" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_haha)"/><circle cx="14.5" cy="17" r="1.7" fill="#3a2b00"/><circle cx="25.5" cy="17" r="1.7" fill="#3a2b00"/><path d="M11.5 22.5c1 3.3 4.3 5.5 8.5 5.5s7.5-2.2 8.5-5.5" stroke="#3a2b00" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>' },
    { key: 'wow', label: 'Wow', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_wow" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_wow)"/><ellipse cx="14.5" cy="17" rx="1.8" ry="2.3" fill="#3a2b00"/><ellipse cx="25.5" cy="17" rx="1.8" ry="2.3" fill="#3a2b00"/><ellipse cx="20" cy="26" rx="3.2" ry="4.2" fill="#3a2b00"/></svg>' },
    { key: 'sad', label: 'Sad', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_sad" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_sad)"/><circle cx="14.5" cy="17" r="1.7" fill="#3a2b00"/><circle cx="25.5" cy="17" r="1.7" fill="#3a2b00"/><path d="M12 28c1.5-2.5 4-4 8-4s6.5 1.5 8 4" stroke="#3a2b00" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>' },
    { key: 'angry', label: 'Angry', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_angry" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ff6b4a"/><stop offset="1" stop-color="#b81c1c"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_angry)"/><circle cx="14.5" cy="18" r="1.7" fill="#3a0000"/><circle cx="25.5" cy="18" r="1.7" fill="#3a0000"/><path d="M11.5 15l4 2M28.5 15l-4 2" stroke="#3a0000" stroke-width="2" stroke-linecap="round"/><path d="M13 27c2-2 4.5-3 7-3s5 1 7 3" stroke="#3a0000" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>' },
    { key: 'fire', label: 'Fire', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_fire" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffb547"/><stop offset="1" stop-color="#e85a00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_fire)"/><path d="M20 9c1 3 3 4 4 6.5 1 2.5 1 4.5-1 6.5 2 0 4-1 5-3 0 5-3 9-8 9s-8-4-8-8.5c0-2.5 1.5-4.5 3-6 1.5-1.5 2.5-2.5 3-4.5.7.5 1.4 1 2 0z" fill="#fff"/></svg>' },
    { key: 'clap', label: 'Clap', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_clap" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#e08a00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_clap)"/><path d="M13 24c0-2 1-3 2.5-3.5.5-2 2-3 3.5-3 0-1.5 1-2.5 2.5-2.5s2.5 1 2.5 2.5c1.5 0 2.5 1.5 2.5 3 .5 0 1.5.5 1.5 2 0 3-2.5 5.5-6 5.5-3.5 0-5-.5-5-.5z" fill="#fff"/></svg>' },
    { key: 'star', label: 'Star', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_star" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffe066"/><stop offset="1" stop-color="#d18f00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_star)"/><path d="M20 9l3.4 7 7.6 1.1-5.5 5.4 1.3 7.5L20 26.5l-6.8 3.5 1.3-7.5L9 17.1 16.6 16z" fill="#fff"/></svg>' },
    { key: 'rocket', label: 'Rocket', svg: '<svg viewBox="0 0 40 40"><defs><radialGradient id="r_rocket" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#8b95ff"/><stop offset="1" stop-color="#3a2ba8"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_rocket)"/><path d="M20 8c3 2 5 6 5 10v3h-10v-3c0-4 2-8 5-10z" fill="#fff"/><circle cx="20" cy="16" r="1.8" fill="#3a2ba8"/></svg>' },
  ];

  function buildReactionsPicker() {
    if (!DOM.reactionsPickerInner) return;
    DOM.reactionsPickerInner.innerHTML = REACTIONS.map(function(r) {
      return '<button class="reaction-emoji" data-key="' + r.key + '" aria-label="' + r.label + '" title="' + r.label + '">' + r.svg + '</button>';
    }).join('');
    var btns = DOM.reactionsPickerInner.querySelectorAll('.reaction-emoji');
    for (var i = 0; i < btns.length; i++) {
      (function(btn) {
        btn.addEventListener('click', function(e) { e.stopPropagation(); sendReaction(btn.dataset.key); });
      })(btns[i]);
    }
  }

  async function sendReaction(key) {
    if (!currentStream) return;
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');

    var newCount = (currentStream.likes_count || 0) + 1;
    currentStream.likes_count = newCount;
    if (DOM.likeCount) DOM.likeCount.textContent = newCount;
    userLiked = true;

    spawnReactionFloat(key);

    try {
      await supabase.from('live_videos').update({ likes_count: newCount }).eq('id', currentStream.id);
    } catch (e) {}
  }

  function spawnReactionFloat(key) {
    if (!DOM.reactionLayer) return;
    var r = REACTIONS[0];
    for (var i = 0; i < REACTIONS.length; i++) {
      if (REACTIONS[i].key === key) { r = REACTIONS[i]; break; }
    }
    var el = document.createElement('div');
    el.className = 'float-heart';
    el.style.width = '44px';
    el.style.height = '44px';
    el.innerHTML = r.svg;
    el.style.left = (40 + Math.random() * 60) + 'px';
    el.style.bottom = '120px';
    el.style.transform = 'translateX(' + ((Math.random() - 0.5) * 40) + 'px)';
    DOM.reactionLayer.appendChild(el);
    setTimeout(function() { try { el.remove(); } catch (e) {} }, 2400);
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 FULLSCREEN
  // ════════════════════════════════════════════════════════════
  async function toggleFullscreen() {
    var target = DOM.streamStage || DOM.streamModal;
    if (!target) return;
    var isFs = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;

    if (!isFs) {
      var req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
      if (req) {
        try {
          await req.call(target);
          try {
            if (screen.orientation && screen.orientation.lock) {
              await screen.orientation.lock('landscape').catch(function() {});
            }
          } catch (e) {}
        } catch (e) {}
      }
    } else {
      try {
        if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      } catch (e) {}
      var exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) { try { await exit.call(document); } catch (e) {} }
    }
  }

  function updateFullscreenIcon() {
    var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
    var icon = document.getElementById('fsIcon');
    if (icon) {
      if (isFs) {
        icon.innerHTML = '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>';
      } else {
        icon.innerHTML = '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>';
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 CONTROLS VISIBILITY
  // ════════════════════════════════════════════════════════════
  function showControls(show) {
    controlsVisible = show;
    if (DOM.streamTopbar) DOM.streamTopbar.classList.toggle('hide', !show);
    if (DOM.streamBottombar) DOM.streamBottombar.classList.toggle('hide', !show);
    if (DOM.liveWatermark) DOM.liveWatermark.classList.toggle('hide', !show);
    if (!show && DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');
    if (show) scheduleHideControls();
  }
  function scheduleHideControls() {
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(function() {
      if (DOM.streamVideo && DOM.streamVideo.paused) return;
      showControls(false);
    }, 4500);
  }
  function toggleControls() {
    if (controlsVisible) showControls(false);
    else showControls(true);
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 REALTIME (DEBOUNCED)
  // ════════════════════════════════════════════════════════════
  function subscribeRealtime() {
    if (!supabase) return;
    try {
      realtimeChannel = supabase.channel('live_videos_public_v24')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, function() {
          // Debounce: batch events within REALTIME_DEBOUNCE_MS
          if (realtimeDebounce) return;
          realtimeDebounce = setTimeout(function() {
            realtimeDebounce = null;
            loadAll(true);
          }, REALTIME_DEBOUNCE_MS);
        })
        .subscribe(function() {});
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // 🎯 PUBLIC REFRESH
  // ════════════════════════════════════════════════════════════
  window.LiveRefresh = function() {
    return loadAll(true);
  };

  // ════════════════════════════════════════════════════════════
  // 🎯 INIT
  // ════════════════════════════════════════════════════════════
  function init() {
    if (appInited) return;
    if (!enforceLogin()) return;
    appInited = true;

    // Ensure token in all places (cookie fallback for WebView)
    var token = getAkimarkToken();
    if (token) setTokenInAllPlaces(token);

    bindDom();
    buildReactionsPicker();
    renderUserBadge();

    loadTimeoutHandle = setTimeout(function() {
      if (!initialLoadDone) {
        initialLoadDone = true;
        renderAll();
      }
    }, LOAD_TIMEOUT_MS);

    if (DOM.streamClose) DOM.streamClose.addEventListener('click', closeStream);

    if (DOM.streamTapLayer) {
      DOM.streamTapLayer.addEventListener('click', function() {
        if (DOM.reactionsPicker && DOM.reactionsPicker.classList.contains('open')) {
          DOM.reactionsPicker.classList.remove('open');
          return;
        }
        toggleControls();
      });
    }

    if (DOM.likeBtn) DOM.likeBtn.addEventListener('click', function(e) { e.stopPropagation(); toggleLike(); });

    if (DOM.reactionsToggleBtn) {
      DOM.reactionsToggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        showControls(true);
        if (DOM.reactionsPicker) DOM.reactionsPicker.classList.toggle('open');
      });
    }

    if (DOM.fullscreenBtn) {
      DOM.fullscreenBtn.addEventListener('click', function(e) { e.stopPropagation(); toggleFullscreen(); });
    }
    ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach(function(ev) {
      document.addEventListener(ev, updateFullscreenIcon);
    });

    [DOM.streamTopbar, DOM.streamBottombar].forEach(function(el) {
      if (!el) return;
      el.addEventListener('click', function() { scheduleHideControls(); });
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && DOM.streamModal && DOM.streamModal.classList.contains('open')) {
        if (DOM.reactionsPicker && DOM.reactionsPicker.classList.contains('open')) {
          DOM.reactionsPicker.classList.remove('open');
          return;
        }
        closeStream();
      }
      if (e.key === ' ' && DOM.streamModal && DOM.streamModal.classList.contains('open')) {
        e.preventDefault();
        if (DOM.streamVideo) {
          if (DOM.streamVideo.paused) DOM.streamVideo.play().catch(function() {});
          else DOM.streamVideo.pause();
        }
      }
    });

    window.addEventListener('storage', function(e) {
      if (e.key === AKMARK_TOKEN_KEY || e.key === AKMARK_USER_KEY) {
        if (!isAkimarkLoggedIn()) {
          window.location.replace(LOGIN_URL);
          return;
        }
        renderUserBadge();
      }
    });

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) return;
      if (!isAkimarkLoggedIn()) {
        window.location.replace(LOGIN_URL);
        return;
      }
      renderUserBadge();

      // Refresh list if cache is stale
      var cached = cacheReadLives();
      if (!cached || cached.age > TTL_LIVES) {
        loadAll(false);
      }
    });

    // Zero-block init: cache-first
    loadAll(false);
    subscribeRealtime();

    // Polling fallback: 2 min (only when tab visible)
    if (loadTimer) clearInterval(loadTimer);
    loadTimer = setInterval(function() {
      if (document.hidden) return;
      loadAll(false);
    }, LIVES_POLL_MS);

    // Cleanup
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);
  }

  function cleanup() {
    if (hls) { try { hls.destroy(); } catch (e) {} }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
    if (progressSimTimer) { clearInterval(progressSimTimer); progressSimTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (loadTimeoutHandle) { clearTimeout(loadTimeoutHandle); loadTimeoutHandle = null; }
    if (realtimeDebounce) { clearTimeout(realtimeDebounce); realtimeDebounce = null; }
    if (realtimeChannel) { try { realtimeChannel.unsubscribe(); } catch (e) {} }
    stopStatsPolling();
    if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

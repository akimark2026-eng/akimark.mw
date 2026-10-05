// live.js (v17 — Immersive Player, no double-scene, fullscreen, 10 SVG reactions,
//           auto-poster capture, fast-open, pre-loaded comments/likes)
(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const HLS_PATH = '/hls';

  const STREAM_BASE = (function() {
    const h = window.location.hostname;
    if (!h) return 'https://akimark.mw';
    if (h === 'akimark.mw' || h === 'www.akimark.mw') return 'https://akimark.mw';
    if (h.endsWith('.akimark.mw')) return 'https://' + h;
    return 'https://akimark.mw';
  })();

  const POSTER_KEY = 'akimark_poster_v1_';
  const USER_NAME_KEY = 'akimark_display_name';
  const RECENT_COMMENTS_LIMIT = 10;
  const PRELOAD_POSTERS_MAX = 3;

  // ════════════════════════════════════════════════════════════
  // SUPABASE
  // ════════════════════════════════════════════════════════════
  let supabase = null;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && typeof window.supabase.createClient === 'function') {
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) {}
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

  // background poster queue
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
  function getStoredPoster(id) {
    try { return localStorage.getItem(POSTER_KEY + id) || null; } catch (e) { return null; }
  }
  function setStoredPoster(id, url) {
    try { localStorage.setItem(POSTER_KEY + id, url); } catch (e) {}
  }
  function getDisplayName() {
    try { return localStorage.getItem(USER_NAME_KEY) || 'Guest'; } catch (e) { return 'Guest'; }
  }

  // ════════════════════════════════════════════════════════════
  // HLS URL BUILDER
  // ════════════════════════════════════════════════════════════
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
  // LOAD STREAMS
  // ════════════════════════════════════════════════════════════
  async function loadAll() {
    if (!supabase) return;
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

      renderAll();

      // ── AUTO-BACKGROUND POSTER CAPTURE ──
      // Silently captures posters for streams that don't have one yet,
      // so when any user clicks Live, the poster is ALREADY ready.
      if (!currentStream) {
        liveStreams.slice(0, PRELOAD_POSTERS_MAX).forEach(enqueuePosterCapture);
      }
    } catch (err) { /* silent */ }
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

    return `
      <div class="live-card ${cardClass}" data-id="${s.id}">
        <div class="live-thumb">
          <div class="live-thumb-placeholder"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg></div>
          ${poster ? `<img class="live-thumb-poster ready" src="${poster}" alt="">` : `<img class="live-thumb-poster" data-poster="${s.id}" alt="">`}
          <span class="${badgeClass}">${badgeLabel}</span>
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
  // OPEN STREAM — FAST OPEN
  // 1. poster imawoneka nthawi yomweyo (native video.poster)
  // 2. comments + stats zimayamba parallel ndi HLS
  // 3. modal imatseguka nthawi yomweyo
  // ════════════════════════════════════════════════════════════
  async function openStream(id, isLive) {
    const list = isLive ? liveStreams : previousStreams;
    const stream = list.find((s) => s.id === id);
    if (!stream) return;

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

    // ── FAST PAINT: title / meta ──
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

    // ── FAST PAINT: poster as background of video (instant image) ──
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

    // ── START PARALLEL WORK ──
    // HLS
    retryCount = 0;
    attachHls(stream, isLive);
    // Stats + Comments in parallel (do not await)
    if (isLive) incrementView(stream.id);
    startStatsPolling(stream.id, isLive);
    // Pre-fetch comments immediately
    prefetchComments(stream.id);
  }

  async function prefetchComments(streamId) {
    if (!supabase || !DOM.modalCommentList) return;
    try {
      const { data } = await supabase
        .from('live_comments')
        .select('id,user_name,message,created_at')
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
    // exit fullscreen if active
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
  }

  // ════════════════════════════════════════════════════════════
  // ATTACH HLS — v17
  //  • Never destroy HLS on transient network errors → no double-scene
  //  • Never remove video.src after first play started
  //  • Full loader only before first play; small buffering indicator after
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

    // ── SILENT pre-flight (no counters shown) ──
    try {
      const res = await fetch(hlsUrl, { method: 'GET', mode: 'cors', credentials: 'include', cache: 'no-store' });
      const body = await res.text().catch(() => '');
      if (res.status === 404 || res.status >= 500) {
        retryCount++;
        if (retryCount <= 30) {
          // silent retry — never show counter
          retryTimer = setTimeout(() => attachHls(stream, isLive), 2500);
        } else {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream unavailable';
        }
        return;
      }
      if (res.status === 200 && !body.includes('#EXTM3U')) {
        if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Loading…';
      }
    } catch (fetchErr) {
      // continue — hls.js may still work
    }

    // ═══ HLS.js ═══
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

      // ── ERROR HANDLING (no double-scene) ──
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;

        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          const playing = DOM.streamVideo && !DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2 && DOM.streamVideo.currentTime > 0;

          if (playing) {
            // Silent recovery — keep playing, small buffering indicator
            showBuffering();
            try { hls.startLoad(); } catch (e) {}
            scheduleHideBuffering(4000);
          } else {
            // First-time / stalled early — keep full loader
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

        // Other fatal errors — stop, but keep last frame visible
        stallDisabled = true;
        if (!hasStartedPlayback) {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = isLive ? 'Stream ended' : 'Replay unavailable';
        }
      });

      // ── MARK PLAYBACK START ──
      const onFirstPlay = () => {
        if (hasStartedPlayback) return;
        hasStartedPlayback = true;
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        hideBuffering();

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
        // if buffering indicator is showing but we have data → hide
        if (!DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2) {
          hideBuffering();
        }
      });

      DOM.streamVideo.addEventListener('waiting', () => {
        if (hasStartedPlayback && !DOM.streamVideo.paused) {
          showBuffering();
        }
      });

      DOM.streamVideo.addEventListener('canplay', () => {
        hideBuffering();
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(DOM.streamVideo);

      // ── SMART WATCHDOG (gentle, no double-scene) ──
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
      // Native HLS (Safari / iOS)
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
          if (!posterCaptured) {
            posterCaptured = true;
            setTimeout(() => capturePoster(stream.id), 1500);
          }
          showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
        }
      }, { once: true });
    } else {
      if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Playback not supported';
    }
  }

  // ════════════════════════════════════════════════════════════
  // BUFFERING INDICATOR
  // ════════════════════════════════════════════════════════════
  function showBuffering() {
    if (!DOM.bufferingIndicator) return;
    DOM.bufferingIndicator.classList.add('show');
  }
  function hideBuffering() {
    if (!DOM.bufferingIndicator) return;
    DOM.bufferingIndicator.classList.remove('show');
  }
  function scheduleHideBuffering(ms) {
    if (bufferingTimer) clearTimeout(bufferingTimer);
    bufferingTimer = setTimeout(() => hideBuffering(), ms);
  }

  // ════════════════════════════════════════════════════════════
  // POSTER CAPTURE — foreground (current user)
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
    } catch (e) { /* tainted canvas — skip */ }
  }

  function updateCardPoster(streamId, url) {
    document.querySelectorAll(`.live-card[data-id="${streamId}"] .live-thumb-poster`).forEach((img) => {
      img.src = url;
      img.classList.add('ready');
    });
  }

  // ════════════════════════════════════════════════════════════
  // POSTER CAPTURE — BACKGROUND QUEUE
  // Captures poster for streams even when user doesn't watch them.
  // Runs one at a time, silent, low-bandwidth.
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
    if (currentStream) return; // don't compete with user viewing
    posterProcessing = true;

    while (posterQueue.length) {
      if (currentStream) break;
      const stream = posterQueue.shift();
      try { await capturePosterBackground(stream); } catch (e) {}
      // small delay between captures
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
  // VIEW INCREMENT
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

      const { data: comments } = await supabase
        .from('live_comments').select('id,user_name,message,created_at')
        .eq('live_id', liveId).order('created_at', { ascending: false }).limit(RECENT_COMMENTS_LIMIT);

      renderComments(comments || []);
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // COMMENTS (Facebook Live bubbles)
  // ════════════════════════════════════════════════════════════
  function renderComments(comments) {
    if (!DOM.modalCommentList) return;
    const sig = comments.map((c) => c.id).join('|');
    if (sig === lastCommentsSig) return;
    lastCommentsSig = sig;

    const ordered = comments.slice().reverse(); // oldest → newest (top → bottom)

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

  // ════════════════════════════════════════════════════════════
  // LIKES
  // ════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════
  // HEART FLOAT ANIMATION (SVG)
  // ════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════
  // 10 REAL SVG REACTIONS (Facebook-style 3D feel)
  // ════════════════════════════════════════════════════════════
  const REACTIONS = [
    {
      key: 'like',
      label: 'Like',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_like" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#5eb1ff"/><stop offset="1" stop-color="#0d6efd"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_like)"/><path d="M28 18h-4.2v-4.4c0-1.1-.6-1.8-1.7-1.8h-1.6c-.6 0-1.1.5-1.2 1.1l-.5 3.2c-.1.6-.5 1-1.1 1.3l-3.9 1.9h-.9c-.6 0-1.1.5-1.1 1.1v6.1c0 .6.5 1.1 1.1 1.1h9.6c.7 0 1.3-.5 1.4-1.2l1.5-5.2c.2-.6.1-1.3-.2-1.8-.3-.5-.8-.8-1.4-.8z" fill="#fff"/></svg>`
    },
    {
      key: 'love',
      label: 'Love',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_love" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ff6b8a"/><stop offset="1" stop-color="#e0245e"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_love)"/><path d="M20 28s-8-5-8-11.2c0-2.8 2.2-5 5-5 1.7 0 3.2.8 4 2.1.8-1.3 2.3-2.1 4-2.1 2.8 0 5 2.2 5 5C30 23 20 28 20 28z" fill="#fff"/></svg>`
    },
    {
      key: 'haha',
      label: 'Haha',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_haha" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_haha)"/><circle cx="14.5" cy="17" r="1.7" fill="#3a2b00"/><circle cx="25.5" cy="17" r="1.7" fill="#3a2b00"/><path d="M11.5 22.5c1 3.3 4.3 5.5 8.5 5.5s7.5-2.2 8.5-5.5" stroke="#3a2b00" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M14 26.6c1.7 1.2 4 1.2 6 0" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`
    },
    {
      key: 'wow',
      label: 'Wow',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_wow" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_wow)"/><ellipse cx="14.5" cy="17" rx="1.8" ry="2.3" fill="#3a2b00"/><ellipse cx="25.5" cy="17" rx="1.8" ry="2.3" fill="#3a2b00"/><ellipse cx="20" cy="26" rx="3.2" ry="4.2" fill="#3a2b00"/></svg>`
    },
    {
      key: 'sad',
      label: 'Sad',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_sad" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#f5a300"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_sad)"/><circle cx="14.5" cy="17" r="1.7" fill="#3a2b00"/><circle cx="25.5" cy="17" r="1.7" fill="#3a2b00"/><path d="M12 28c1.5-2.5 4-4 8-4s6.5 1.5 8 4" stroke="#3a2b00" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M26 20c0 1.5-1 3-2.5 3.5 1.5.6 3-1 3-2.5 0-.6-.2-1-.5-1z" fill="#4fc3f7"/></svg>`
    },
    {
      key: 'angry',
      label: 'Angry',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_angry" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ff6b4a"/><stop offset="1" stop-color="#b81c1c"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_angry)"/><circle cx="14.5" cy="18" r="1.7" fill="#3a0000"/><circle cx="25.5" cy="18" r="1.7" fill="#3a0000"/><path d="M11.5 15l4 2M28.5 15l-4 2" stroke="#3a0000" stroke-width="2" stroke-linecap="round"/><path d="M13 27c2-2 4.5-3 7-3s5 1 7 3" stroke="#3a0000" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>`
    },
    {
      key: 'fire',
      label: 'Fire',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_fire" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffb547"/><stop offset="1" stop-color="#e85a00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_fire)"/><path d="M20 9c1 3 3 4 4 6.5 1 2.5 1 4.5-1 6.5 2 0 4-1 5-3 0 5-3 9-8 9s-8-4-8-8.5c0-2.5 1.5-4.5 3-6 1.5-1.5 2.5-2.5 3-4.5.7.5 1.4 1 2 0z" fill="#fff"/><path d="M20 16c0 2-1 3-1 4.5 0 1.5 1 2.5 1 2.5s1-1 1-2.5c0-1.5-1-2.5-1-4.5z" fill="#ffb547"/></svg>`
    },
    {
      key: 'clap',
      label: 'Clap',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_clap" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffd54a"/><stop offset="1" stop-color="#e08a00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_clap)"/><path d="M13 24c0-2 1-3 2.5-3.5.5-2 2-3 3.5-3 0-1.5 1-2.5 2.5-2.5s2.5 1 2.5 2.5c1.5 0 2.5 1.5 2.5 3 .5 0 1.5.5 1.5 2 0 3-2.5 5.5-6 5.5-3.5 0-5-.5-5-.5z" fill="#fff"/><path d="M14 22l1.5-3M17 21l1-3M20 20l1-3" stroke="#e08a00" stroke-width="1.2" stroke-linecap="round"/></svg>`
    },
    {
      key: 'star',
      label: 'Star',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_star" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#ffe066"/><stop offset="1" stop-color="#d18f00"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_star)"/><path d="M20 9l3.4 7 7.6 1.1-5.5 5.4 1.3 7.5L20 26.5l-6.8 3.5 1.3-7.5L9 17.1 16.6 16z" fill="#fff"/></svg>`
    },
    {
      key: 'rocket',
      label: 'Rocket',
      svg: `<svg viewBox="0 0 40 40"><defs><radialGradient id="r_rocket" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="#8b95ff"/><stop offset="1" stop-color="#3a2ba8"/></radialGradient></defs><circle cx="20" cy="20" r="19" fill="url(#r_rocket)"/><path d="M20 8c3 2 5 6 5 10v3h-10v-3c0-4 2-8 5-10z" fill="#fff"/><circle cx="20" cy="16" r="1.8" fill="#3a2ba8"/><path d="M15 21l-2 4 4-1zM25 21l2 4-4-1z" fill="#fff"/><path d="M18 24l-1.5 6c0 .5.5.5.7.2l2.3-3h1l2.3 3c.2.3.7.3.7-.2l-1.5-6z" fill="#ffb547"/></svg>`
    },
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
    // Close picker
    if (DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');

    // Update like count (each reaction = 1 like for now)
    const newCount = (currentStream.likes_count || 0) + 1;
    currentStream.likes_count = newCount;
    if (DOM.likeCount) DOM.likeCount.textContent = newCount;
    userLiked = true;

    // Float the chosen SVG
    spawnReactionFloat(key);

    try {
      await supabase.from('live_videos').update({ likes_count: newCount }).eq('id', currentStream.id);
    } catch (e) {}
  }

  function spawnReactionFloat(key) {
    if (!DOM.reactionLayer) return;
    const r = REACTIONS.find((x) => x.key === key) || REACTIONS[0];
    const el = document.createElement('div');
    el.className = 'float-heart';
    el.style.width = '44px';
    el.style.height = '44px';
    el.innerHTML = r.svg;
    const left = 40 + Math.random() * 60;
    el.style.left = left + 'px';
    el.style.bottom = '120px';
    el.style.transform = `translateX(${(Math.random() - 0.5) * 40}px)`;
    DOM.reactionLayer.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 2400);
  }

  // ════════════════════════════════════════════════════════════
  // FULLSCREEN
  // ════════════════════════════════════════════════════════════
  function toggleFullscreen() {
    const target = DOM.streamStage || DOM.streamModal;
    if (!target) return;

    const isFs = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;

    if (!isFs) {
      const req = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
      if (req) {
        try { req.call(target); } catch (e) {}
      }
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (exit) {
        try { exit.call(document); } catch (e) {}
      }
    }
  }

  function updateFullscreenIcon() {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
    const icon = document.getElementById('fsIcon');
    if (!icon) return;
    if (isFs) {
      icon.innerHTML = `<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>`;
    } else {
      icon.innerHTML = `<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`;
    }
  }

  // ════════════════════════════════════════════════════════════
  // SEND COMMENT
  // ════════════════════════════════════════════════════════════
  async function sendComment() {
    if (!currentStream || !DOM.commentInput) return;
    const msg = DOM.commentInput.value.trim();
    if (!msg) return;
    DOM.commentInput.value = '';
    DOM.commentInput.blur();

    const name = getDisplayName();
    const nowIso = new Date().toISOString();

    // optimistic bubble
    const tempId = 'tmp_' + Date.now();
    const existing = DOM.modalCommentList ? Array.from(DOM.modalCommentList.querySelectorAll('.comment-bubble')).map((b) => ({
      id: b.dataset.id,
      user_name: b.querySelector('.c-name')?.textContent || '',
      message: b.querySelector('.c-msg')?.textContent || '',
      created_at: nowIso,
    })) : [];
    renderComments([
      { id: tempId, user_name: name, message: msg, created_at: nowIso },
      ...existing,
    ]);

    try {
      await supabase.from('live_comments').insert({
        live_id: currentStream.id,
        user_name: name,
        message: msg,
        created_at: nowIso,
      });
      const newCount = (currentStream.comments_count || 0) + 1;
      currentStream.comments_count = newCount;
      if (DOM.commentCount) DOM.commentCount.textContent = newCount;
      await supabase.from('live_videos').update({ comments_count: newCount }).eq('id', currentStream.id);
    } catch (e) {
      showToast('Comment failed');
    }
  }

  // ════════════════════════════════════════════════════════════
  // CONTROLS VISIBILITY
  // ════════════════════════════════════════════════════════════
  function showControls(show) {
    controlsVisible = show;
    if (DOM.streamTopbar) DOM.streamTopbar.classList.toggle('hide', !show);
    if (DOM.streamBottombar) DOM.streamBottombar.classList.toggle('hide', !show);
    if (DOM.modalCommentList) DOM.modalCommentList.classList.toggle('hide', !show);
    if (!show && DOM.reactionsPicker) DOM.reactionsPicker.classList.remove('open');
    if (show) scheduleHideControls();
  }
  function scheduleHideControls() {
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      if (DOM.streamVideo && DOM.streamVideo.paused) return;
      showControls(false);
    }, 4500);
  }
  function toggleControls() {
    if (controlsVisible) showControls(false);
    else showControls(true);
  }

  // ════════════════════════════════════════════════════════════
  // REALTIME
  // ════════════════════════════════════════════════════════════
  function subscribeRealtime() {
    if (!supabase) return;
    try {
      supabase.channel('live_videos_public_v17')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, () => loadAll())
        .subscribe(() => {});
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════
  function init() {
    bindDom();
    buildReactionsPicker();

    if (DOM.streamClose) DOM.streamClose.addEventListener('click', closeStream);

    // tap-to-toggle controls
    if (DOM.streamTapLayer) {
      DOM.streamTapLayer.addEventListener('click', () => {
        // close reactions picker if open
        if (DOM.reactionsPicker && DOM.reactionsPicker.classList.contains('open')) {
          DOM.reactionsPicker.classList.remove('open');
          return;
        }
        toggleControls();
      });
    }

    // like
    if (DOM.likeBtn) DOM.likeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLike(); });

    // reactions toggle
    if (DOM.reactionsToggleBtn) {
      DOM.reactionsToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showControls(true);
        if (DOM.reactionsPicker) DOM.reactionsPicker.classList.toggle('open');
      });
    }

    // fullscreen
    if (DOM.fullscreenBtn) {
      DOM.fullscreenBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
    }
    ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach((ev) => {
      document.addEventListener(ev, updateFullscreenIcon);
    });

    // comment focus
    if (DOM.commentFocusBtn) DOM.commentFocusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showControls(true);
      if (DOM.commentInput) DOM.commentInput.focus();
    });
    if (DOM.commentSend) DOM.commentSend.addEventListener('click', (e) => { e.stopPropagation(); sendComment(); });
    if (DOM.commentInput) {
      DOM.commentInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendComment(); }
      });
      DOM.commentInput.addEventListener('focus', () => { showControls(true); if (controlsHideTimer) clearTimeout(controlsHideTimer); });
    }

    [DOM.streamTopbar, DOM.streamBottombar].forEach((el) => {
      if (!el) return;
      el.addEventListener('click', () => { scheduleHideControls(); });
    });

    document.addEventListener('keydown', (e) => {
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
          if (DOM.streamVideo.paused) DOM.streamVideo.play().catch(() => {});
          else DOM.streamVideo.pause();
        }
      }
    });

    loadAll();
    subscribeRealtime();
    if (loadTimer) clearInterval(loadTimer);
    loadTimer = setInterval(loadAll, 20000);

    window.addEventListener('beforeunload', () => {
      if (hls) { try { hls.destroy(); } catch (e) {} }
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (bufferingTimer) clearTimeout(bufferingTimer);
      stopStatsPolling();
      if (loadTimer) clearInterval(loadTimer);
      if (retryTimer) clearTimeout(retryTimer);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

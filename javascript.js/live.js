// live.js (v16 — Immersive Player, silent retries, poster capture, real likes/comments)
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
  let posterCaptured = false;
  let controlsHideTimer = null;
  let controlsVisible = true;
  let lastCommentsSig = '';
  let seenCommentIds = new Set();
  let commentFadeTimers = new Map();

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
      streamModalLabel: $('streamModalLabel'), modalTitle: $('modalTitle'),
      modalBroadcaster: $('modalBroadcaster'), modalViews: $('modalViews'),
      modalCommentList: $('modalCommentList'), reactionLayer: $('reactionLayer'),
      likeBtn: $('likeBtn'), likeCount: $('likeCount'),
      commentCount: $('commentCount'), commentFocusBtn: $('commentFocusBtn'),
      commentInput: $('commentInput'), commentSend: $('commentSend'),
      streamTopbar: $('streamTopbar'), streamBottombar: $('streamBottombar'),
      streamTapLayer: $('streamTapLayer'),
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
  // OPEN / CLOSE
  // ════════════════════════════════════════════════════════════
  async function openStream(id, isLive) {
    const list = isLive ? liveStreams : previousStreams;
    const stream = list.find((s) => s.id === id);
    if (!stream) return;

    currentStream = stream;
    currentIsLive = isLive;
    posterCaptured = false;
    seenCommentIds.clear();
    lastCommentsSig = '';

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

    if (DOM.streamModal) DOM.streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';

    // reset controls
    showControls(true);

    if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = '';
    if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');

    retryCount = 0;
    attachHls(stream, isLive);
    if (isLive) incrementView(stream.id);
    startStatsPolling(stream.id, isLive);
  }

  function closeStream() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
    if (DOM.streamModal) DOM.streamModal.classList.remove('open');
    document.body.style.overflow = '';
    stopStatsPolling();
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (DOM.streamVideo) {
      try { DOM.streamVideo.pause(); } catch (e) {}
      DOM.streamVideo.removeAttribute('src');
      try { DOM.streamVideo.load(); } catch (e) {}
    }
    // clear fade timers
    commentFadeTimers.forEach((t) => clearTimeout(t));
    commentFadeTimers.clear();
    currentStream = null;
    currentIsLive = false;
  }

  // ════════════════════════════════════════════════════════════
  // ATTACH HLS — silent retries, no counter, autoplay unmuted
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

    // ── pre-flight (silent — no counters shown to user) ──
    try {
      const res = await fetch(hlsUrl, { method: 'GET', mode: 'cors', credentials: 'include', cache: 'no-store' });
      const body = await res.text().catch(() => '');
      if (res.status === 404 || res.status >= 500) {
        retryCount++;
        if (retryCount <= 20) {
          retryTimer = setTimeout(() => attachHls(stream, isLive), 3000);
        } else {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream unavailable';
        }
        return;
      }
      if (res.status === 200 && !body.includes('#EXTM3U')) {
        if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Loading…';
      }
    } catch (fetchErr) {
      // continue — hls.js might still work
    }

    // ── HLS.js ──
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 40,          // 🔑 low-network friendly
        maxMaxBufferLength: 90,
        maxBufferSize: 90 * 1000 * 1000,
        maxBufferHole: 1.0,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 12,
        highBufferWatchdogPeriod: 2,
        abrEwmaDefaultEstimate: 800000,   // 🔑 start conservative for weak networks
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.75,       // 🔑 less aggressive upswitching
        startLevel: -1,
        fragLoadingMaxRetry: 10,
        fragLoadingMaxRetryTimeout: 64000,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 8,
        enableWorker: true,
        xhrSetup: function (xhr) { xhr.withCredentials = true; },
      });

      let hasStartedPlaying = false;
      let lastProgressAt = Date.now();
      let recoveryAttempts = 0;
      let stallDisabled = false;

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (DOM.streamVideo) {
          DOM.streamVideo.muted = false;
          DOM.streamVideo.volume = 1;
          const p = DOM.streamVideo.play();
          if (p && p.catch) p.catch(() => {
            // fallback: mute & retry to force autoplay
            DOM.streamVideo.muted = true;
            DOM.streamVideo.play().catch(() => {});
            // give user a chance to unmute via controls
          });
        }
      });

      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          const playing = DOM.streamVideo && !DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2 && DOM.streamVideo.currentTime > 0;
          if (playing) {
            try { hls.startLoad(); } catch (e) {}
          } else {
            if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Reconnecting…';
            if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
            setTimeout(() => {
              try { hls.startLoad(); } catch (e) {}
            }, 1200);
          }
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          stallDisabled = true;
        }
      });

      const onPlaying = () => {
        if (!hasStartedPlaying) {
          hasStartedPlaying = true;
          // 🎉 Welcome toast
          showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
          // 📸 capture poster (once per stream)
          if (!posterCaptured) {
            posterCaptured = true;
            setTimeout(() => capturePoster(stream.id), 2500);
          }
        }
        lastProgressAt = Date.now();
        recoveryAttempts = 0;
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
      };

      DOM.streamVideo.addEventListener('playing', onPlaying);

      DOM.streamVideo.addEventListener('timeupdate', () => {
        lastProgressAt = Date.now();
        if (recoveryAttempts > 0) recoveryAttempts = 0;
        if (!hasStartedPlaying) {
          hasStartedPlaying = true;
          showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
          if (!posterCaptured) {
            posterCaptured = true;
            setTimeout(() => capturePoster(stream.id), 2500);
          }
        }
        if (DOM.videoLoader && !DOM.videoLoader.classList.contains('hidden')) {
          if (!DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2) {
            DOM.videoLoader.classList.add('hidden');
          }
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(DOM.streamVideo);

      // ── smart watchdog ──
      watchdogTimer = setInterval(() => {
        if (!hls || !DOM.streamVideo || !isLive) return;
        if (stallDisabled) return;
        if (!hasStartedPlaying) return;
        if (DOM.streamVideo.paused || DOM.streamVideo.ended) return;

        const timeSinceProgress = Date.now() - lastProgressAt;
        if (timeSinceProgress > 2500) {
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
      }, 1400);

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
        if (!posterCaptured) {
          posterCaptured = true;
          setTimeout(() => capturePoster(stream.id), 2500);
        }
        showToast(isLive ? 'Welcome to Live' : 'Welcome back', { welcome: true, duration: 3200 });
      }, { once: true });
    } else {
      if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Playback not supported';
    }
  }

  // ════════════════════════════════════════════════════════════
  // POSTER CAPTURE
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
        // update DOM card if present
        document.querySelectorAll(`.live-thumb-poster[data-poster="${streamId}"]`).forEach((img) => {
          img.src = url;
          img.classList.add('ready');
        });
        document.querySelectorAll(`.live-card[data-id="${streamId}"] .live-thumb-poster`).forEach((img) => {
          img.src = url;
          img.classList.add('ready');
        });
      }
    } catch (e) { /* tainted canvas — skip */ }
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
      if (DOM.likeCount) DOM.likeCount.textContent = live.likes_count || 0;
      if (DOM.commentCount) DOM.commentCount.textContent = live.comments_count || 0;

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
        .eq('live_id', liveId).order('created_at', { ascending: false }).limit(20);

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

    // ordered oldest → newest (top → bottom)
    const ordered = comments.slice().reverse();

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

      // fade older comments after a while (live only)
      if (currentIsLive && !seenCommentIds.has(c.id)) {
        seenCommentIds.add(c.id);
        const t = setTimeout(() => {
          bubble.classList.add('fade');
          setTimeout(() => { try { bubble.remove(); } catch (e) {} }, 700);
        }, 12000);
        commentFadeTimers.set(c.id, t);
      }
    });

    // keep overlay scroll at bottom
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

    // optimistic UI
    currentStream.likes_count = newCount;
    if (DOM.likeCount) DOM.likeCount.textContent = newCount;
    if (DOM.likeBtn) DOM.likeBtn.classList.toggle('liked', !alreadyLiked);

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
    const left = 40 + Math.random() * 60; // near left bottom
    el.style.left = left + 'px';
    el.style.bottom = '120px';
    el.style.transform = `translateX(${(Math.random() - 0.5) * 40}px)`;
    DOM.reactionLayer.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (e) {} }, 2400);
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
    renderComments([
      { id: tempId, user_name: name, message: msg, created_at: nowIso },
      ...((DOM.modalCommentList.dataset.cache && JSON.parse(DOM.modalCommentList.dataset.cache)) || [])
    ]);

    try {
      await supabase.from('live_comments').insert({
        live_id: currentStream.id,
        user_name: name,
        message: msg,
        created_at: nowIso,
      });
      // bump comment count
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
    if (show) scheduleHideControls();
  }
  function scheduleHideControls() {
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      if (DOM.streamVideo && DOM.streamVideo.paused) return;
      showControls(false);
    }, 4000);
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
      supabase.channel('live_videos_public_v16')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, () => loadAll())
        .subscribe(() => {});
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════
  function init() {
    bindDom();

    if (DOM.streamClose) DOM.streamClose.addEventListener('click', closeStream);

    // tap-to-toggle controls
    if (DOM.streamTapLayer) {
      DOM.streamTapLayer.addEventListener('click', toggleControls);
    }

    // like
    if (DOM.likeBtn) DOM.likeBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleLike(); });

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

    // any user interaction with controls keeps them visible
    [DOM.streamTopbar, DOM.streamBottombar].forEach((el) => {
      if (!el) return;
      el.addEventListener('click', () => { scheduleHideControls(); });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && DOM.streamModal && DOM.streamModal.classList.contains('open')) closeStream();
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
      stopStatsPolling();
      if (loadTimer) clearInterval(loadTimer);
      if (retryTimer) clearTimeout(retryTimer);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

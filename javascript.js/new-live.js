// live.js (v12 — Best of v10+v11: stable start + fast scene-change recovery)
(function() {
  'use strict';

  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const STREAM_BASE = 'https://akimark.mw';
  const HLS_PATH = '/hls';
  const DEBUG = false;

  let statusEl = null;
  function ensureStatusEl() {
    if (!DEBUG) return null;
    if (statusEl && document.body.contains(statusEl)) return statusEl;
    statusEl = document.createElement('div');
    statusEl.id = 'liveDiagBar';
    statusEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:rgba(0,0,0,0.92);color:#fff;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:1.35;padding:6px 8px;max-height:180px;overflow-y:auto;border-bottom:2px solid #c71515;';
    if (document.body.firstChild) document.body.insertBefore(statusEl, document.body.firstChild);
    else document.body.appendChild(statusEl);
    return statusEl;
  }
  const STATUS_LOG = [];
  function step(msg, extra) {
    if (!DEBUG) return;
    const t = new Date().toISOString().slice(11, 19);
    let line = `[${t}] ${msg}`;
    if (extra !== undefined) { try { line += ' :: ' + (typeof extra === 'object' ? JSON.stringify(extra) : String(extra)); } catch (e) {} }
    STATUS_LOG.push(line);
    console.log('[live.js]', msg, extra || '');
    const el = ensureStatusEl();
    if (!el) return;
    el.innerHTML = STATUS_LOG.map((l, i) => `<div style="color:${l.includes('❌') ? '#ff5a5a' : (i === STATUS_LOG.length - 1 ? '#4ade80' : '#a7a7a7')}">${String(l).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}</div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  step('live.js v12 boot');

  let supabase = null;
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase && typeof window.supabase.createClient === 'function') {
    try { supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); step('Supabase OK'); }
    catch (e) { step('❌ Supabase init failed', e); }
  } else {
    step('❌ Supabase NOT initialized');
  }

  let liveStreams = [];
  let previousStreams = [];
  let currentStream = null;
  let hls = null;
  let statsPollTimer = null;
  let loadTimer = null;
  let retryTimer = null;
  let retryCount = 0;

  const $ = (id) => document.getElementById(id);
  let DOM = {};

  function bindDom() {
    DOM = {
      liveGrid: $('liveGrid'), liveCount: $('liveCount'), emptyState: $('emptyState'),
      navLiveBadge: $('navLiveBadge'), toast: $('toast'), toastMsg: $('toastMsg'),
      previousSection: $('previousSection'), previousGrid: $('previousGrid'), prevCount: $('prevCount'),
      streamModal: $('streamModal'), streamClose: $('streamClose'), streamVideo: $('streamVideo'),
      videoLoader: $('videoLoader'), videoLoaderText: $('videoLoaderText'),
      streamModalLabel: $('streamModalLabel'), modalTitle: $('modalTitle'), modalAvatar: $('modalAvatar'),
      modalBroadcaster: $('modalBroadcaster'), modalViews: $('modalViews'), modalLikes: $('modalLikes'),
      modalComments: $('modalComments'), modalCommentList: $('modalCommentList'), paidBanner: $('paidBanner'),
    };
  }

  function escapeHtml(str) {
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
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    } catch (e) { return '—'; }
  }
  function formatMWK(n) { return 'MWK ' + Number(n || 0).toLocaleString(); }
  function initials(name) {
    const n = (name || 'A').trim();
    const parts = n.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  function showToast(msg) {
    if (!DOM.toast || !DOM.toastMsg) return;
    DOM.toastMsg.textContent = msg;
    DOM.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => DOM.toast.classList.remove('show'), 2600);
  }

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
        .select('id,title,status,mode,stream_key,hls_url,actual_start,actual_end,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price', { count: 'exact' })
        .eq('status', 'ended').order('actual_end', { ascending: false }).limit(5);
      if (prevRes.error) step('Prev query failed', prevRes.error);
      previousStreams = prevRes.data || [];

      renderAll();
    } catch (err) { step('❌ loadAll', err); }
  }

  function renderAll() {
    if (DOM.liveCount) DOM.liveCount.textContent = liveStreams.length;
    if (liveStreams.length > 0) {
      if (DOM.navLiveBadge) DOM.navLiveBadge.classList.remove('off');
      document.title = `🔴 LIVE (${liveStreams.length}) | Akimark`;
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

    return `
      <div class="live-card ${cardClass}" data-id="${s.id}">
        <div class="live-thumb">
          <div class="live-thumb-placeholder"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg></div>
          <span class="${badgeClass}">${badgeLabel}</span>
          <span class="live-viewers"><svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${views}</span>
          <span class="live-price ${priceClass}">${escapeHtml(priceLabel)}</span>
        </div>
        <div class="live-info">
          <div class="live-title">${escapeHtml(s.title || 'Live Stream')}</div>
          <div class="live-broadcaster"><div class="avatar">${escapeHtml(av)}</div><span>${escapeHtml(broadcaster)}</span></div>
          <div class="live-stats-row">
            <span><svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${likes}</span>
            <span><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${s.comments_count || 0}</span>
            <span style="margin-left:auto;">${timeLabel}</span>
          </div>
        </div>
      </div>`;
  }

  async function openStream(id, isLive) {
    const list = isLive ? liveStreams : previousStreams;
    const stream = list.find((s) => s.id === id);
    if (!stream) return;
    currentStream = stream;
    if (DOM.modalTitle) DOM.modalTitle.textContent = stream.title || 'Live Stream';
    const broadcaster = stream.broadcaster_name || 'Akimark';
    if (DOM.modalBroadcaster) DOM.modalBroadcaster.textContent = broadcaster;
    if (DOM.modalAvatar) DOM.modalAvatar.textContent = initials(broadcaster);
    if (DOM.modalViews) DOM.modalViews.textContent = stream.views_count || 0;
    if (DOM.modalLikes) DOM.modalLikes.textContent = stream.likes_count || 0;
    if (DOM.modalComments) DOM.modalComments.textContent = stream.comments_count || 0;
    if (DOM.streamModalLabel) {
      DOM.streamModalLabel.textContent = isLive ? 'Live' : 'Ended';
      DOM.streamModalLabel.classList.toggle('ended', !isLive);
    }
    const isFree = stream.is_free !== false;
    if (DOM.paidBanner) {
      if (!isFree) { DOM.paidBanner.textContent = `Paid stream — ${formatMWK(stream.price)}`; DOM.paidBanner.classList.add('show'); }
      else DOM.paidBanner.classList.remove('show');
    }
    if (DOM.modalCommentList) DOM.modalCommentList.innerHTML = '<div class="comment-empty">No comments yet</div>';
    if (DOM.streamModal) DOM.streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = isLive ? 'Connecting to stream…' : 'Loading replay…';
    if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
    retryCount = 0;
    attachHls(stream, isLive);
    if (isLive) incrementView(stream.id);
    startStatsPolling(stream.id, isLive);
  }

  // ════════════════════════════════════════════════════════════
  // 🔑 ATTACH HLS — v12 (stable + fast recovery)
  // ════════════════════════════════════════════════════════════
  async function attachHls(stream, isLive) {
    const hlsUrl = stream.hls_url || (stream.stream_key ? `${STREAM_BASE}${HLS_PATH}/${stream.stream_key}/index.m3u8` : '');
    step('attachHls', { hlsUrl, isLive, retryCount });

    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (attachHls._watchdog) { clearInterval(attachHls._watchdog); attachHls._watchdog = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (DOM.streamVideo) {
      try { DOM.streamVideo.pause(); } catch (e) {}
      DOM.streamVideo.removeAttribute('src');
      try { DOM.streamVideo.load(); } catch (e) {}
    }
    if (!hlsUrl) {
      if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
      showToast('Stream URL missing');
      step('❌ HLS URL empty');
      return;
    }

    // Pre-check
    try {
      const res = await fetch(hlsUrl, { method: 'GET', mode: 'cors', credentials: 'include' });
      step('pre-check', { status: res.status });
      if (res.status === 404) {
        retryCount++;
        if (retryCount <= 12) {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream starting…';
          retryTimer = setTimeout(() => attachHls(stream, isLive), 4000);
        } else {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream never became ready';
        }
        return;
      }
      if (res.status === 401) { if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Auth required'; return; }
      if (res.status >= 500) { if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Server error'; return; }
    } catch (e) { step('pre-check fail', e); }

    if (window.Hls && window.Hls.isSupported()) {
      // ═══ hls.js config — v10's stable params ═══
      hls = new window.Hls({
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 120 * 1000 * 1000,
        maxBufferHole: 1.0,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 15,
        liveDurationInfinity: true,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 10,
        highBufferWatchdogPeriod: 2,
        abrEwmaDefaultEstimate: 1000000,
        abrBandWidthFactor: 1.0,
        abrBandWidthUpFactor: 0.9,
        startLevel: -1,
        fragLoadingMaxRetry: 8,
        fragLoadingMaxRetryTimeout: 64000,
        manifestLoadingMaxRetry: 4,
        levelLoadingMaxRetry: 6,
        levelLoadingMaxRetryTimeout: 30000,
        enableWorker: true,
        xhrSetup: function (xhr) { xhr.withCredentials = true; },
      });

      // ═══ STATE for smart watchdog ═══
      let hasStartedPlaying = false;  // 🔑 gate — only act AFTER video played
      let lastProgressAt = Date.now();
      let recoveryAttempts = 0;
      let stallRecoveryDisabled = false;

      // Track when video actually starts playing
      function markPlaying() {
        if (!hasStartedPlaying) {
          hasStartedPlaying = true;
          step('video started playing — watchdog enabled');
        }
        lastProgressAt = Date.now();
        recoveryAttempts = 0;
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
      }

      hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
        if (!hasStartedPlaying) {
          // Give hls.js a moment — don't mark yet
        }
      });

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        step('✅ manifest parsed');
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        DOM.streamVideo.play().catch(() => {});
      });

      // DOM events
      DOM.streamVideo.addEventListener('playing', markPlaying);
      DOM.streamVideo.addEventListener('timeupdate', () => {
        lastProgressAt = Date.now();
        if (recoveryAttempts > 0) recoveryAttempts = 0;
        if (!hasStartedPlaying) hasStartedPlaying = true;
      });

      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;

        step('HLS fatal', { type: data.type, details: data.details });

        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Reconnecting…';
          setTimeout(() => {
            try { hls.startLoad(); } catch (e) {}
            // Only hide loader if video successfully playing
            setTimeout(() => {
              if (DOM.streamVideo && !DOM.streamVideo.paused && DOM.streamVideo.readyState >= 2) {
                if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
              }
            }, 1500);
          }, 1200);
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = isLive ? 'Stream ended' : 'Replay unavailable';
          if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
          stallRecoveryDisabled = true;
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(DOM.streamVideo);

      // ═══ Smart watchdog — only acts AFTER video played ═══
      attachHls._watchdog = setInterval(() => {
        if (!hls || !DOM.streamVideo || !isLive) return;
        if (stallRecoveryDisabled) return;
        if (!hasStartedPlaying) return;               // 🔑 Skip initial load
        if (DOM.streamVideo.paused) return;            // User paused
        if (DOM.streamVideo.ended) return;

        const timeSinceProgress = Date.now() - lastProgressAt;

        if (timeSinceProgress > 2500) {
          recoveryAttempts++;

          if (recoveryAttempts === 1) {
            // Gentle nudge first
            step('watchdog: nudge (attempt 1)');
            try { hls.startLoad(); } catch (e) {}
          } else if (recoveryAttempts <= 3) {
            // Try to jump forward within buffer
            step('watchdog: forward jump (attempt ' + recoveryAttempts + ')');
            try {
              const buffered = DOM.streamVideo.buffered;
              if (buffered.length > 0) {
                const lastEnd = buffered.end(buffered.length - 1);
                const curr = DOM.streamVideo.currentTime;
                if (lastEnd > curr + 0.5) {
                  DOM.streamVideo.currentTime = lastEnd - 0.5;
                  DOM.streamVideo.play().catch(() => {});
                } else {
                  hls.startLoad();
                }
              }
            } catch (e) {}
          } else {
            // Hard recovery — jump to live edge
            step('watchdog: HARD jump to live edge (attempt ' + recoveryAttempts + ')');
            try {
              const buffered = DOM.streamVideo.buffered;
              if (buffered.length > 0) {
                const liveEdge = buffered.end(buffered.length - 1);
                DOM.streamVideo.currentTime = Math.max(0, liveEdge - 1.5);
                DOM.streamVideo.play().catch(() => {});
              } else {
                // No buffer at all — restart hls load
                hls.startLoad(-1);
              }
            } catch (e) {}
          }

          lastProgressAt = Date.now();
        }
      }, 1200);

    } else if (DOM.streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
      DOM.streamVideo.src = hlsUrl;
      DOM.streamVideo.crossOrigin = 'use-credentials';
      DOM.streamVideo.addEventListener('loadedmetadata', () => {
        if (DOM.videoLoader) DOM.videoLoader.classList.add('hidden');
        DOM.streamVideo.play().catch(() => {});
      }, { once: true });
    } else {
      if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'HLS not supported';
    }
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
  function stopStatsPolling() { if (statsPollTimer) { clearInterval(statsPollTimer); statsPollTimer = null; } }

  async function fetchStats(liveId, isLive) {
    try {
      const { data: live } = await supabase
        .from('live_videos').select('views_count,likes_count,comments_count,status,is_active')
        .eq('id', liveId).maybeSingle();
      if (!live) return;
      if (DOM.modalViews) DOM.modalViews.textContent = live.views_count || 0;
      if (DOM.modalLikes) DOM.modalLikes.textContent = live.likes_count || 0;
      if (DOM.modalComments) DOM.modalComments.textContent = live.comments_count || 0;
      if (isLive && (live.status !== 'live' || live.is_active === false)) {
        if (DOM.videoLoaderText) DOM.videoLoaderText.textContent = 'Stream ended';
        if (DOM.videoLoader) DOM.videoLoader.classList.remove('hidden');
        if (DOM.streamModalLabel) { DOM.streamModalLabel.textContent = 'Ended'; DOM.streamModalLabel.classList.add('ended'); }
        if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        stopStatsPolling();
      }
      const { data: comments } = await supabase
        .from('live_comments').select('id,user_name,message,created_at')
        .eq('live_id', liveId).order('created_at', { ascending: false }).limit(30);
      if (comments && comments.length > 0 && DOM.modalCommentList) {
        DOM.modalCommentList.innerHTML = comments.map((c) => `
          <div class="comment-item">
            <div class="comment-head"><span class="comment-user">${escapeHtml(c.user_name || 'Viewer')}</span><span class="comment-time">${formatTime(c.created_at)}</span></div>
            <div class="comment-msg">${escapeHtml(c.message || '')}</div>
          </div>`).join('');
      } else if (DOM.modalCommentList) {
        DOM.modalCommentList.innerHTML = '<div class="comment-empty">No comments yet</div>';
      }
    } catch (e) {}
  }

  function closeStream() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (attachHls._watchdog) { clearInterval(attachHls._watchdog); attachHls._watchdog = null; }
    if (DOM.streamModal) DOM.streamModal.classList.remove('open');
    document.body.style.overflow = '';
    stopStatsPolling();
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (DOM.streamVideo) {
      try { DOM.streamVideo.pause(); } catch (e) {}
      DOM.streamVideo.removeAttribute('src');
      try { DOM.streamVideo.load(); } catch (e) {}
    }
    currentStream = null;
  }

  function subscribeRealtime() {
    if (!supabase) return;
    try {
      supabase.channel('live_videos_public_v12').on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, () => loadAll()).subscribe();
    } catch (e) {}
  }

  function init() {
    bindDom();
    if (DOM.streamClose) DOM.streamClose.addEventListener('click', closeStream);
    if (DOM.streamModal) {
      DOM.streamModal.addEventListener('click', (e) => { if (e.target === DOM.streamModal) closeStream(); });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && DOM.streamModal && DOM.streamModal.classList.contains('open')) closeStream();
    });
    loadAll();
    subscribeRealtime();
    if (loadTimer) clearInterval(loadTimer);
    loadTimer = setInterval(loadAll, 20000);
    window.addEventListener('beforeunload', () => {
      if (hls) { try { hls.destroy(); } catch (e) {} }
      if (attachHls._watchdog) { clearInterval(attachHls._watchdog); }
      stopStatsPolling();
      if (loadTimer) clearInterval(loadTimer);
      if (retryTimer) clearTimeout(retryTimer);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

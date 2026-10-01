// live.js (v3 — no skeleton, exact errors, shows previous 5 ended streams)
(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const STREAM_BASE = 'https://akimark.mw';
  const HLS_PATH = '/hls';

  // ════════════════════════════════════════════════════════════
  // LOG (console + kept for error panel)
  // ════════════════════════════════════════════════════════════
  const LOGS = [];
  function log(msg, data) {
    const line = `[live.js] ${msg}` + (data !== undefined ? ' — ' + (typeof data === 'object' ? JSON.stringify(data) : data) : '');
    console.log(line);
    LOGS.push(line);
  }
  function logErr(msg, err) {
    const line = `[live.js] ❌ ${msg}` + (err ? ' — ' + (err.message || err) : '');
    console.error(line, err);
    LOGS.push(line);
  }

  log('boot', {
    url: SUPABASE_URL ? 'set' : '❌ MISSING',
    key: SUPABASE_ANON_KEY ? 'set' : '❌ MISSING',
    supabase: typeof window.supabase,
    hls: typeof window.Hls,
  });

  // ════════════════════════════════════════════════════════════
  // BOOT — validate dependencies up-front
  // ════════════════════════════════════════════════════════════
  let supabase = null;
  let configError = null;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    configError = 'Supabase config missing — check javascript.js/supabase.js (window.SUPABASE_URL, window.SUPABASE_ANON_KEY)';
    logErr(configError);
  } else if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    configError = 'Supabase JS library not loaded — check <script src="...@supabase/supabase-js@2">';
    logErr(configError);
  } else {
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      log('Supabase client created OK');
    } catch (e) {
      configError = 'Supabase createClient failed: ' + (e.message || e);
      logErr(configError, e);
    }
  }

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let liveStreams = [];
  let previousStreams = [];
  let currentStream = null;
  let hls = null;
  let statsPollTimer = null;
  let loadTimer = null;
  let errorShown = false;

  // ════════════════════════════════════════════════════════════
  // DOM
  // ════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);
  const liveGrid = $('liveGrid');
  const liveCount = $('liveCount');
  const emptyState = $('emptyState');
  const navLiveBadge = $('navLiveBadge');
  const toast = $('toast');
  const toastMsg = $('toastMsg');
  const previousSection = $('previousSection');
  const previousGrid = $('previousGrid');
  const prevCount = $('prevCount');

  const streamModal = $('streamModal');
  const streamClose = $('streamClose');
  const streamVideo = $('streamVideo');
  const videoLoader = $('videoLoader');
  const videoLoaderText = $('videoLoaderText');
  const streamModalLabel = $('streamModalLabel');
  const modalTitle = $('modalTitle');
  const modalAvatar = $('modalAvatar');
  const modalBroadcaster = $('modalBroadcaster');
  const modalViews = $('modalViews');
  const modalLikes = $('modalLikes');
  const modalComments = $('modalComments');
  const modalCommentList = $('modalCommentList');
  const paidBanner = $('paidBanner');

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function formatTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = Math.floor((now - d.getTime()) / 1000);
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
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  // ════════════════════════════════════════════════════════════
  // ERROR PANEL (replaces skeleton entirely)
  // ════════════════════════════════════════════════════════════
  function showErrorPanel(title, lines) {
    if (!liveGrid) return;
    errorShown = true;
    if (emptyState) emptyState.style.display = 'none';
    if (previousSection) previousSection.style.display = 'none';

    const detailHtml = (lines || LOGS).map((l) => escapeHtml(l)).join('\n');
    liveGrid.innerHTML = `
      <div class="error-panel">
        <div class="error-head">
          <div class="error-ic">
            <svg viewBox="0 0 24 24"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>
          </div>
          <div class="error-title">${escapeHtml(title)}</div>
        </div>
        <div class="error-body">${detailHtml}</div>
        <div class="error-actions">
          <button class="error-btn retry" id="liveRetryBtn">🔄 Retry</button>
          <button class="error-btn copy" id="liveCopyBtn">📋 Copy Logs</button>
        </div>
      </div>`;
    const retry = document.getElementById('liveRetryBtn');
    if (retry) retry.onclick = () => { LOGS.length = 0; errorShown = false; loadAll(); };
    const copy = document.getElementById('liveCopyBtn');
    if (copy) copy.onclick = () => {
      navigator.clipboard?.writeText(LOGS.join('\n')).then(() => {
        copy.textContent = '✅ Copied';
        setTimeout(() => copy.textContent = '📋 Copy Logs', 1500);
      });
    };
  }

  // ════════════════════════════════════════════════════════════
  // LOAD: live streams + previous streams
  // ════════════════════════════════════════════════════════════
  async function loadAll() {
    log('loadAll() start');

    // Show a subtle inline text — NOT a skeleton
    if (liveGrid && !errorShown) {
      liveGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#A7A7A7;font-size:0.85rem;padding:40px 10px;">Loading live streams…</div>`;
    }
    if (emptyState) emptyState.style.display = 'none';
    if (previousSection) previousSection.style.display = 'none';

    if (configError) {
      logErr('Config error');
      showErrorPanel('Configuration Error', [
        configError,
        '',
        'Check the browser console (F12) for details.',
      ]);
      if (liveCount) liveCount.textContent = '0';
      if (navLiveBadge) navLiveBadge.classList.add('off');
      return;
    }

    try {
      log('Querying live_videos (live)');
      const t0 = Date.now();
      const liveRes = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,webrtc_url,is_active,actual_start,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price,admin_id', { count: 'exact' })
        .eq('status', 'live')
        .eq('is_active', true)
        .order('actual_start', { ascending: false })
        .limit(50);

      log('Live query done', { ms: Date.now() - t0, rows: (liveRes.data || []).length, count: liveRes.count, error: liveRes.error?.message });

      if (liveRes.error) throw liveRes.error;

      liveStreams = liveRes.data || [];

      // Fetch previous 5 ended streams
      log('Querying live_videos (ended, prev 5)');
      const prevRes = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,actual_start,actual_end,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price', { count: 'exact' })
        .eq('status', 'ended')
        .order('actual_end', { ascending: false })
        .limit(5);

      log('Prev query done', { rows: (prevRes.data || []).length, error: prevRes.error?.message });

      if (prevRes.error) logErr('Prev query failed', prevRes.error);
      previousStreams = prevRes.data || [];

      renderAll();

      // Debug if nothing at all
      if (liveStreams.length === 0 && previousStreams.length === 0) {
        log('Zero rows total — dumping latest rows for debug');
        const { data: all, error: e2 } = await supabase
          .from('live_videos')
          .select('id,title,status,is_active,actual_start,actual_end,created_at')
          .order('created_at', { ascending: false })
          .limit(10);
        if (e2) logErr('Debug query failed', e2);
        else log('Debug — latest rows:', all);
      }
    } catch (err) {
      logErr('loadAll failed', err);
      showErrorPanel('Could not load live streams', [
        'Message: ' + (err.message || String(err)),
        'Code: ' + (err.code || '—'),
        'Details: ' + (err.details || '—'),
        'Hint: ' + (err.hint || '—'),
        '',
        'Possible causes:',
        ' • RLS on live_videos blocks anon SELECT',
        ' • Network / CORS',
        ' • Wrong SUPABASE_URL',
        '',
        '— Full log —',
        ...LOGS,
      ]);
      if (liveCount) liveCount.textContent = '0';
      if (navLiveBadge) navLiveBadge.classList.add('off');
    }
  }

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════
  function renderAll() {
    log('renderAll', { live: liveStreams.length, prev: previousStreams.length });

    if (liveCount) liveCount.textContent = liveStreams.length;

    if (liveStreams.length > 0) {
      if (navLiveBadge) navLiveBadge.classList.remove('off');
      document.title = `🔴 LIVE (${liveStreams.length}) | Akimark`;
    } else {
      if (navLiveBadge) navLiveBadge.classList.add('off');
      document.title = 'Live | Akimark';
    }

    if (!liveGrid) return;

    // Live section
    if (liveStreams.length === 0) {
      liveGrid.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
    } else {
      if (emptyState) emptyState.style.display = 'none';
      liveGrid.innerHTML = liveStreams.map((s) => cardHTML(s, true)).join('');
      liveGrid.querySelectorAll('.live-card').forEach((el) => {
        el.addEventListener('click', () => openStream(el.dataset.id, true));
      });
    }

    // Previous section
    if (previousStreams.length > 0 && previousSection && previousGrid) {
      previousSection.style.display = 'block';
      if (prevCount) prevCount.textContent = String(previousStreams.length);
      previousGrid.innerHTML = previousStreams.map((s) => cardHTML(s, false)).join('');
      previousGrid.querySelectorAll('.live-card').forEach((el) => {
        el.addEventListener('click', () => openStream(el.dataset.id, false));
      });
    } else if (previousSection) {
      previousSection.style.display = 'none';
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
          <div class="live-thumb-placeholder">
            <svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>
          </div>
          <span class="${badgeClass}">${badgeLabel}</span>
          <span class="live-viewers">
            <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            ${views}
          </span>
          <span class="live-price ${priceClass}">${escapeHtml(priceLabel)}</span>
        </div>
        <div class="live-info">
          <div class="live-title">${escapeHtml(s.title || 'Live Stream')}</div>
          <div class="live-broadcaster">
            <div class="avatar">${escapeHtml(av)}</div>
            <span>${escapeHtml(broadcaster)}</span>
          </div>
          <div class="live-stats-row">
            <span>
              <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              ${likes}
            </span>
            <span>
              <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${s.comments_count || 0}
            </span>
            <span style="margin-left:auto;">${timeLabel}</span>
          </div>
        </div>
      </div>`;
  }

  // ════════════════════════════════════════════════════════════
  // OPEN STREAM
  // ════════════════════════════════════════════════════════════
  async function openStream(id, isLive) {
    const list = isLive ? liveStreams : previousStreams;
    const stream = list.find((s) => s.id === id);
    if (!stream) return;

    log('openStream', { id, isLive, title: stream.title });
    currentStream = stream;

    modalTitle.textContent = stream.title || 'Live Stream';
    const broadcaster = stream.broadcaster_name || 'Akimark';
    modalBroadcaster.textContent = broadcaster;
    modalAvatar.textContent = initials(broadcaster);
    modalViews.textContent = stream.views_count || 0;
    modalLikes.textContent = stream.likes_count || 0;
    modalComments.textContent = stream.comments_count || 0;

    // Modal label
    if (streamModalLabel) {
      streamModalLabel.textContent = isLive ? 'Live' : 'Ended';
      streamModalLabel.classList.toggle('ended', !isLive);
    }

    const isFree = stream.is_free !== false;
    if (!isFree) {
      paidBanner.textContent = `Paid stream — ${formatMWK(stream.price)}`;
      paidBanner.classList.add('show');
    } else {
      paidBanner.classList.remove('show');
    }

    modalCommentList.innerHTML = '<div class="comment-empty">No comments yet</div>';
    streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (videoLoaderText) videoLoaderText.textContent = isLive ? 'Loading live stream…' : 'Loading replay…';
    videoLoader.classList.remove('hidden');

    attachHls(stream, isLive);
    if (isLive) incrementView(stream.id);
    startStatsPolling(stream.id, isLive);
  }

  function attachHls(stream, isLive) {
    const hlsUrl = stream.hls_url || (stream.stream_key ? `${STREAM_BASE}${HLS_PATH}/${stream.stream_key}/index.m3u8` : '');
    log('attachHls', { hlsUrl, isLive });

    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (streamVideo) {
      try { streamVideo.pause(); } catch (e) {}
      streamVideo.removeAttribute('src');
      try { streamVideo.load(); } catch (e) {}
    }
    if (!hlsUrl) {
      videoLoader.classList.add('hidden');
      showToast('Stream URL missing');
      return;
    }
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        lowLatencyMode: isLive,
        liveSyncDurationCount: isLive ? 3 : undefined,
        liveMaxLatencyDurationCount: isLive ? 10 : undefined,
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        log('HLS manifest parsed');
        videoLoader.classList.add('hidden');
        streamVideo.play().catch(() => {});
      });
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        logErr('HLS error', { type: data.type, details: data.details, fatal: data.fatal });
        if (data.fatal) {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            setTimeout(() => { try { hls.startLoad(); } catch (e) {} }, 2000);
          } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            try { hls.recoverMediaError(); } catch (e) {}
          } else {
            if (videoLoaderText) videoLoaderText.textContent = isLive ? 'Stream ended or unavailable' : 'Replay unavailable';
          }
        }
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(streamVideo);
    } else if (streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
      streamVideo.src = hlsUrl;
      streamVideo.addEventListener('loadedmetadata', () => {
        videoLoader.classList.add('hidden');
        streamVideo.play().catch(() => {});
      }, { once: true });
    } else {
      if (videoLoaderText) videoLoaderText.textContent = 'HLS not supported in this browser';
    }
  }

  async function incrementView(liveId) {
    try {
      const { data: cur } = await supabase.from('live_videos').select('views_count').eq('id', liveId).maybeSingle();
      const next = (cur?.views_count || 0) + 1;
      await supabase.from('live_videos').update({ views_count: next }).eq('id', liveId);
      if (currentStream && currentStream.id === liveId) {
        currentStream.views_count = next;
        modalViews.textContent = next;
      }
    } catch (e) { logErr('incrementView', e); }
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
        .from('live_videos')
        .select('views_count,likes_count,comments_count,status,is_active')
        .eq('id', liveId)
        .maybeSingle();
      if (!live) return;
      modalViews.textContent = live.views_count || 0;
      modalLikes.textContent = live.likes_count || 0;
      modalComments.textContent = live.comments_count || 0;

      // If live ended while watching
      if (isLive && (live.status !== 'live' || live.is_active === false)) {
        if (videoLoaderText) videoLoaderText.textContent = 'Stream ended';
        videoLoader.classList.remove('hidden');
        if (streamModalLabel) {
          streamModalLabel.textContent = 'Ended';
          streamModalLabel.classList.add('ended');
        }
        if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        stopStatsPolling();
      }

      const { data: comments } = await supabase
        .from('live_comments')
        .select('id,user_name,message,created_at')
        .eq('live_id', liveId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (comments && comments.length > 0) {
        modalCommentList.innerHTML = comments.map((c) => `
          <div class="comment-item">
            <div class="comment-head">
              <span class="comment-user">${escapeHtml(c.user_name || 'Viewer')}</span>
              <span class="comment-time">${formatTime(c.created_at)}</span>
            </div>
            <div class="comment-msg">${escapeHtml(c.message || '')}</div>
          </div>
        `).join('');
      } else {
        modalCommentList.innerHTML = '<div class="comment-empty">No comments yet</div>';
      }
    } catch (e) { /* silent */ }
  }

  function closeStream() {
    streamModal.classList.remove('open');
    document.body.style.overflow = '';
    stopStatsPolling();
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (streamVideo) {
      try { streamVideo.pause(); } catch (e) {}
      streamVideo.removeAttribute('src');
      try { streamVideo.load(); } catch (e) {}
    }
    currentStream = null;
  }

  function subscribeRealtime() {
    if (!supabase) return;
    try {
      supabase
        .channel('live_videos_public_v3')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, (payload) => {
          log('realtime event', payload.eventType);
          loadAll();
        })
        .subscribe((status) => log('realtime status', status));
    } catch (e) { logErr('realtime subscribe', e); }
  }

  function init() {
    log('init()');
    if (streamClose) streamClose.addEventListener('click', closeStream);
    if (streamModal) {
      streamModal.addEventListener('click', (e) => {
        if (e.target === streamModal) closeStream();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && streamModal.classList.contains('open')) closeStream();
    });

    loadAll();
    subscribeRealtime();
    if (loadTimer) clearInterval(loadTimer);
    loadTimer = setInterval(loadAll, 20000);

    window.addEventListener('beforeunload', () => {
      if (hls) { try { hls.destroy(); } catch (e) {} }
      stopStatsPolling();
      if (loadTimer) clearInterval(loadTimer);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

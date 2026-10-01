// live.js (v2 — visible errors, on-screen diagnostics, always clears skeleton)
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
  // LOG HELPER — logs to console AND shows in banner
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

  // ════════════════════════════════════════════════════════════
  // BOOT — check config immediately
  // ════════════════════════════════════════════════════════════
  log('boot', {
    url: SUPABASE_URL ? 'set (' + SUPABASE_URL.slice(0, 40) + '…)' : '❌ MISSING',
    key: SUPABASE_ANON_KEY ? 'set' : '❌ MISSING',
    supabaseGlobal: typeof window.supabase,
    hlsGlobal: typeof window.Hls,
  });

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
  let currentStream = null;
  let hls = null;
  let statsPollTimer = null;
  let loadTimer = null;

  // ════════════════════════════════════════════════════════════
  // DOM
  // ════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);
  const liveGrid = $('liveGrid');
  const emptyState = $('emptyState');
  const liveCount = $('liveCount');
  const navLiveBadge = $('navLiveBadge');
  const toast = $('toast');
  const toastMsg = $('toastMsg');
  const streamModal = $('streamModal');
  const streamClose = $('streamClose');
  const streamVideo = $('streamVideo');
  const videoLoader = $('videoLoader');
  const modalTitle = $('modalTitle');
  const modalAvatar = $('modalAvatar');
  const modalBroadcaster = $('modalBroadcaster');
  const modalViews = $('modalViews');
  const modalLikes = $('modalLikes');
  const modalComments = $('modalComments');
  const modalCommentList = $('modalCommentList');
  const paidBanner = $('paidBanner');

  log('DOM refs', {
    liveGrid: !!liveGrid, emptyState: !!emptyState, streamModal: !!streamModal,
    streamVideo: !!streamVideo, toast: !!toast,
  });

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
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    } catch (e) { return '—'; }
  }
  function formatMWK(n) { return 'MWK ' + Number(n || 0).toLocaleString(); }
  function showToast(msg) {
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
  }
  function initials(name) {
    const n = (name || 'A').trim();
    const parts = n.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }

  // ════════════════════════════════════════════════════════════
  // ERROR PANEL — replaces skeleton when something breaks
  // ════════════════════════════════════════════════════════════
  function showErrorPanel(title, detailLines) {
    if (!liveGrid) return;
    const detailHtml = (detailLines || LOGS).map((l) => escapeHtml(l)).join('\n');
    liveGrid.innerHTML = `
      <div style="grid-column:1/-1;background:#151515;border:1px solid rgba(199,21,21,0.4);border-radius:16px;padding:18px;color:#fff;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="width:34px;height:34px;border-radius:50%;background:rgba(199,21,21,0.15);display:flex;align-items:center;justify-content:center;">
            <svg viewBox="0 0 24 24" style="width:20px;height:20px;stroke:#ff2d2d;fill:none;stroke-width:2;"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="10"/></svg>
          </div>
          <div style="font-weight:800;font-size:1rem;">${escapeHtml(title)}</div>
        </div>
        <div style="background:#0B0F19;border-radius:10px;padding:12px;font-family:monospace;font-size:0.72rem;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:#F9FAFB;max-height:280px;overflow-y:auto;">${detailHtml}</div>
        <div style="display:flex;gap:8px;margin-top:14px;">
          <button id="liveRetryBtn" style="flex:1;padding:11px;background:linear-gradient(135deg,#c71515,#a00f0f);color:#fff;border:none;border-radius:10px;font-weight:700;font-size:0.82rem;cursor:pointer;">🔄 Retry</button>
          <button id="liveCopyBtn" style="flex:1;padding:11px;background:#1F2937;color:#F9FAFB;border:1px solid #1F2937;border-radius:10px;font-weight:700;font-size:0.82rem;cursor:pointer;">📋 Copy Logs</button>
        </div>
      </div>`;
    const retry = document.getElementById('liveRetryBtn');
    if (retry) retry.onclick = () => { LOGS.length = 0; loadLiveStreams(); };
    const copy = document.getElementById('liveCopyBtn');
    if (copy) copy.onclick = () => {
      navigator.clipboard?.writeText(LOGS.join('\n')).then(() => {
        copy.textContent = '✅ Copied';
        setTimeout(() => copy.textContent = '📋 Copy Logs', 1500);
      });
    };
  }

  // ════════════════════════════════════════════════════════════
  // FETCH LIVE STREAMS
  // ════════════════════════════════════════════════════════════
  async function loadLiveStreams() {
    log('loadLiveStreams() start');

    // Always clear the skeleton first
    if (liveGrid) {
      liveGrid.innerHTML = '<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>';
    }
    if (emptyState) emptyState.style.display = 'none';

    // Config broken → show panel
    if (configError) {
      logErr('Config error prevents loading');
      showErrorPanel('Configuration Error', [
        configError,
        '',
        'Check browser console for details.',
      ]);
      if (liveCount) liveCount.textContent = '0';
      if (navLiveBadge) navLiveBadge.classList.add('off');
      return;
    }

    try {
      log('Querying live_videos where status=live and is_active=true');
      const t0 = Date.now();
      const { data, error, count } = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,webrtc_url,is_active,actual_start,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price,admin_id', { count: 'exact' })
        .eq('status', 'live')
        .eq('is_active', true)
        .order('actual_start', { ascending: false })
        .limit(50);

      log('Query finished', { ms: Date.now() - t0, rows: (data || []).length, count, error: error?.message });

      if (error) throw error;

      liveStreams = data || [];
      renderStreams();

      // If zero rows, also fetch all to debug
      if (liveStreams.length === 0) {
        log('Zero live rows — checking all live_videos for debug');
        const { data: all, error: e2 } = await supabase
          .from('live_videos')
          .select('id,title,status,is_active,admin_id,actual_start')
          .order('created_at', { ascending: false })
          .limit(10);
        if (e2) logErr('Debug query failed', e2);
        else log('Debug — latest rows:', all);
      }
    } catch (err) {
      logErr('loadLiveStreams failed', err);
      showErrorPanel('Could not load live streams', [
        'Error: ' + (err.message || String(err)),
        'Code: ' + (err.code || '—'),
        'Details: ' + (err.details || '—'),
        'Hint: ' + (err.hint || '—'),
        '',
        'Possible causes:',
        ' • RLS blocks SELECT on live_videos for anon role',
        ' • Network / CORS issue with Supabase',
        ' • Wrong SUPABASE_URL in javascript.js/supabase.js',
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
  function renderStreams() {
    log('renderStreams', { count: liveStreams.length });

    if (liveCount) liveCount.textContent = liveStreams.length;

    if (liveStreams.length > 0) {
      if (navLiveBadge) navLiveBadge.classList.remove('off');
      document.title = `🔴 LIVE (${liveStreams.length}) | Akimark`;
    } else {
      if (navLiveBadge) navLiveBadge.classList.add('off');
      document.title = 'Live | Akimark';
    }

    if (!liveGrid) return;

    if (liveStreams.length === 0) {
      liveGrid.innerHTML = '';
      if (emptyState) {
        emptyState.style.display = 'block';
        emptyState.querySelector('h3').textContent = 'No live streams right now';
        emptyState.querySelector('p').textContent = 'Check back soon — live matches, events and exclusive broadcasts will appear here.';
      }
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    liveGrid.innerHTML = liveStreams.map((s) => {
      const isFree = s.is_free !== false;
      const priceLabel = isFree ? 'Free' : formatMWK(s.price);
      const priceClass = isFree ? 'free' : 'paid';
      const views = s.views_count || 0;
      const likes = s.likes_count || 0;
      const broadcaster = s.broadcaster_name || 'Akimark';
      const av = initials(broadcaster);

      return `
        <div class="live-card" data-id="${s.id}">
          <div class="live-thumb">
            <div class="live-thumb-placeholder">
              <svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>
            </div>
            <span class="live-badge-card">LIVE</span>
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
              <span style="margin-left:auto;">Started ${formatTime(s.actual_start || s.created_at)}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');

    liveGrid.querySelectorAll('.live-card').forEach((el) => {
      el.addEventListener('click', () => openStream(el.dataset.id));
    });
  }

  // ════════════════════════════════════════════════════════════
  // OPEN STREAM
  // ════════════════════════════════════════════════════════════
  async function openStream(id) {
    const stream = liveStreams.find((s) => s.id === id);
    if (!stream) return;
    log('openStream', { id, title: stream.title });
    currentStream = stream;

    modalTitle.textContent = stream.title || 'Live Stream';
    const broadcaster = stream.broadcaster_name || 'Akimark';
    modalBroadcaster.textContent = broadcaster;
    modalAvatar.textContent = initials(broadcaster);
    modalViews.textContent = stream.views_count || 0;
    modalLikes.textContent = stream.likes_count || 0;
    modalComments.textContent = stream.comments_count || 0;

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
    videoLoader.classList.remove('hidden');

    attachHls(stream);
    incrementView(stream.id);
    startStatsPolling(stream.id);
  }

  function attachHls(stream) {
    const hlsUrl = stream.hls_url || (stream.stream_key ? `${STREAM_BASE}${HLS_PATH}/${stream.stream_key}/index.m3u8` : '');
    log('attachHls', { hlsUrl });

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
      hls = new window.Hls({ lowLatencyMode: true, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 10 });
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
            videoLoader.querySelector('.video-loader-text').textContent = 'Stream ended or unavailable';
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
      videoLoader.querySelector('.video-loader-text').textContent = 'HLS not supported in this browser';
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

  function startStatsPolling(liveId) {
    stopStatsPolling();
    fetchStats(liveId);
    statsPollTimer = setInterval(() => fetchStats(liveId), 5000);
  }
  function stopStatsPolling() {
    if (statsPollTimer) { clearInterval(statsPollTimer); statsPollTimer = null; }
  }

  async function fetchStats(liveId) {
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
      if (live.status !== 'live' || live.is_active === false) {
        videoLoader.querySelector('.video-loader-text').textContent = 'Stream ended';
        videoLoader.classList.remove('hidden');
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
        .channel('live_videos_public_v2')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, (payload) => {
          log('realtime event', payload.eventType);
          loadLiveStreams();
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

    loadLiveStreams();
    subscribeRealtime();
    if (loadTimer) clearInterval(loadTimer);
    loadTimer = setInterval(loadLiveStreams, 20000);

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

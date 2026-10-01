// live.js (v1 — real live streams for viewers on apk.akimark.mw)
(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // CONFIG
  // ════════════════════════════════════════════════════════════
  const SUPABASE_URL = window.SUPABASE_URL;
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
  const STREAM_BASE = 'https://akimark.mw';
  const HLS_PATH = '/hls';

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('❌ Supabase config missing — check javascript.js/supabase.js');
    return;
  }

  let supabase;
  try {
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.error('❌ Supabase init failed:', e);
    return;
  }

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let liveStreams = [];
  let currentStream = null;
  let hls = null;
  let statsPollTimer = null;

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

  function formatMWK(n) {
    return 'MWK ' + Number(n || 0).toLocaleString();
  }

  function showToast(msg) {
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
  // FETCH LIVE STREAMS
  // ════════════════════════════════════════════════════════════
  async function loadLiveStreams() {
    try {
      const { data, error } = await supabase
        .from('live_videos')
        .select('id,title,status,mode,stream_key,hls_url,webrtc_url,is_active,actual_start,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price,admin_id')
        .eq('status', 'live')
        .eq('is_active', true)
        .order('actual_start', { ascending: false })
        .limit(50);

      if (error) throw error;
      liveStreams = data || [];
      renderStreams();
    } catch (err) {
      console.error('Load live streams error:', err);
      liveGrid.innerHTML = '';
      emptyState.style.display = 'block';
      emptyState.querySelector('h3').textContent = 'Could not load live streams';
      emptyState.querySelector('p').textContent = err.message || 'Please try again later.';
    }
  }

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════
  function renderStreams() {
    liveCount.textContent = liveStreams.length;

    if (liveStreams.length > 0) {
      navLiveBadge.classList.remove('off');
      document.title = `🔴 LIVE (${liveStreams.length}) | Akimark`;
    } else {
      navLiveBadge.classList.add('off');
      document.title = 'Live | Akimark';
    }

    if (liveStreams.length === 0) {
      liveGrid.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';
    liveGrid.innerHTML = liveStreams.map((s) => {
      const hlsUrl = s.hls_url || (s.stream_key ? `${STREAM_BASE}${HLS_PATH}/${s.stream_key}/index.m3u8` : '');
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

    // Attach click handlers
    liveGrid.querySelectorAll('.live-card').forEach((el) => {
      el.addEventListener('click', () => openStream(el.dataset.id));
    });
  }

  // ════════════════════════════════════════════════════════════
  // OPEN STREAM (modal + HLS)
  // ════════════════════════════════════════════════════════════
  async function openStream(id) {
    const stream = liveStreams.find((s) => s.id === id);
    if (!stream) return;

    currentStream = stream;

    // Update modal info
    modalTitle.textContent = stream.title || 'Live Stream';
    const broadcaster = stream.broadcaster_name || 'Akimark';
    modalBroadcaster.textContent = broadcaster;
    modalAvatar.textContent = initials(broadcaster);
    modalViews.textContent = stream.views_count || 0;
    modalLikes.textContent = stream.likes_count || 0;
    modalComments.textContent = stream.comments_count || 0;

    // Paid banner
    const isFree = stream.is_free !== false;
    if (!isFree) {
      paidBanner.textContent = `Paid stream — ${formatMWK(stream.price)}`;
      paidBanner.classList.add('show');
    } else {
      paidBanner.classList.remove('show');
    }

    // Reset comments
    modalCommentList.innerHTML = '<div class="comment-empty">No comments yet</div>';

    // Show modal
    streamModal.classList.add('open');
    document.body.style.overflow = 'hidden';
    videoLoader.classList.remove('hidden');

    // Attach HLS
    attachHls(stream);

    // Increment view (fire-and-forget)
    incrementView(stream.id);

    // Start polling stats
    startStatsPolling(stream.id);
  }

  function attachHls(stream) {
    const hlsUrl = stream.hls_url || (stream.stream_key ? `${STREAM_BASE}${HLS_PATH}/${stream.stream_key}/index.m3u8` : '');

    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (streamVideo) {
      streamVideo.pause();
      streamVideo.removeAttribute('src');
      streamVideo.load();
    }

    if (!hlsUrl) {
      videoLoader.classList.add('hidden');
      showToast('Stream URL missing');
      return;
    }

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
      });

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        videoLoader.classList.add('hidden');
        streamVideo.play().catch(() => {});
      });

      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        console.warn('HLS error:', data);
        if (data.fatal) {
          switch (data.type) {
            case window.Hls.ErrorTypes.NETWORK_ERROR:
              setTimeout(() => { try { hls.startLoad(); } catch (e) {} }, 2000);
              break;
            case window.Hls.ErrorTypes.MEDIA_ERROR:
              try { hls.recoverMediaError(); } catch (e) {}
              break;
            default:
              videoLoader.querySelector('.video-loader-text').textContent = 'Stream ended or unavailable';
              try { hls.destroy(); } catch (e) {}
              break;
          }
        }
      });

      hls.loadSource(hlsUrl);
      hls.attachMedia(streamVideo);
    } else if (streamVideo.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari)
      streamVideo.src = hlsUrl;
      streamVideo.addEventListener('loadedmetadata', () => {
        videoLoader.classList.add('hidden');
        streamVideo.play().catch(() => {});
      }, { once: true });
    } else {
      videoLoader.querySelector('.video-loader-text').textContent = 'HLS not supported in this browser';
    }
  }

  // ════════════════════════════════════════════════════════════
  // INCREMENT VIEW (light)
  // ════════════════════════════════════════════════════════════
  async function incrementView(liveId) {
    try {
      // Read then update (RLS allows anon update per our policy)
      const { data: cur } = await supabase
        .from('live_videos')
        .select('views_count')
        .eq('id', liveId)
        .maybeSingle();

      const next = (cur?.views_count || 0) + 1;
      await supabase
        .from('live_videos')
        .update({ views_count: next })
        .eq('id', liveId);

      if (currentStream && currentStream.id === liveId) {
        currentStream.views_count = next;
        modalViews.textContent = next;
      }
    } catch (e) {
      console.warn('incrementView:', e);
    }
  }

  // ════════════════════════════════════════════════════════════
  // STATS POLLING (every 5s while modal open)
  // ════════════════════════════════════════════════════════════
  function startStatsPolling(liveId) {
    stopStatsPolling();
    fetchStats(liveId);
    statsPollTimer = setInterval(() => fetchStats(liveId), 5000);
  }

  function stopStatsPolling() {
    if (statsPollTimer) {
      clearInterval(statsPollTimer);
      statsPollTimer = null;
    }
  }

  async function fetchStats(liveId) {
    try {
      const { data: live } = await supabase
        .from('live_videos')
        .select('views_count,likes_count,comments_count,status,is_active')
        .eq('id', liveId)
        .maybeSingle();

      if (!live) return;

      // Update counters
      modalViews.textContent = live.views_count || 0;
      modalLikes.textContent = live.likes_count || 0;
      modalComments.textContent = live.comments_count || 0;

      // If stream ended, show notice
      if (live.status !== 'live' || live.is_active === false) {
        videoLoader.querySelector('.video-loader-text').textContent = 'Stream ended';
        videoLoader.classList.remove('hidden');
        if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        stopStatsPolling();
      }

      // Fetch comments
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
    } catch (e) {
      // Silent
    }
  }

  // ════════════════════════════════════════════════════════════
  // CLOSE STREAM
  // ════════════════════════════════════════════════════════════
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

  // ════════════════════════════════════════════════════════════
  // REALTIME — auto-add/remove cards when streams start/stop
  // ════════════════════════════════════════════════════════════
  function subscribeRealtime() {
    try {
      supabase
        .channel('live_videos_public')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, () => {
          loadLiveStreams();
        })
        .subscribe();
    } catch (e) {
      console.warn('Realtime subscribe failed:', e);
    }
  }

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════
  function init() {
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

    // Refresh every 20s (in case realtime drops)
    setInterval(loadLiveStreams, 20000);

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
      if (hls) { try { hls.destroy(); } catch (e) {} }
      stopStatsPolling();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

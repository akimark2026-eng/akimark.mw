// live.js (v16 — Modern UI, real-time likes/comments/views, autoplay+unmute, thumbnails)
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

  // User identity (persistent per device)
  function getUserId() {
    let id = localStorage.getItem('akmark_user_id');
    if (!id) {
      id = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('akmark_user_id', id);
    }
    return id;
  }
  function getUserName() {
    let n = localStorage.getItem('akmark_user_name');
    if (!n) {
      n = 'Viewer' + Math.floor(Math.random() * 9000 + 1000);
      localStorage.setItem('akmark_user_name', n);
    }
    return n;
  }
  const USER_ID = getUserId();
  const USER_NAME = getUserName();

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let liveStreams = [];
  let previousStreams = [];
  let currentStream = null;
  let hls = null;
  let statsPollTimer = null;
  let loadTimer = null;
  let retryTimer = null;
  let retryCount = 0;
  let commentsChannel = null;
  let controlsHideTimer = null;
  let likedStreams = JSON.parse(localStorage.getItem('akmark_liked') || '{}');

  // ════════════════════════════════════════════════════════════
  // DOM
  // ════════════════════════════════════════════════════════════
  const $ = (id) => document.getElementById(id);

  // ════════════════════════════════════════════════════════════
  // SUPABASE
  // ════════════════════════════════════════════════════════════
  let supabase = null;
  try {
    if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase) {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
  } catch (e) { console.warn('Supabase init failed'); }

  // ════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════
  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function initials(name) {
    const n = (name || 'A').trim();
    const parts = n.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  function formatTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const diff = Math.floor((Date.now() - d.getTime()) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return `${d.getDate()}/${d.getMonth() + 1}`;
    } catch (e) { return '—'; }
  }
  function formatFullTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const m = new Date(d.getTime() + 2 * 3600000);
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${String(m.getUTCDate()).padStart(2, '0')} ${months[m.getUTCMonth()]} • ${String(m.getUTCHours()).padStart(2, '0')}:${String(m.getUTCMinutes()).padStart(2, '0')}`;
    } catch (e) { return '—'; }
  }
  function formatMWK(n) { return 'MWK ' + Number(n || 0).toLocaleString(); }
  function showToast(msg) {
    const t = $('toast');
    const m = $('toastMsg');
    if (!t || !m) return;
    m.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ════════════════════════════════════════════════════════════
  // THUMBNAIL CAPTURE
  // ════════════════════════════════════════════════════════════
  function getThumbKey(streamId) { return 'akmark_thumb_' + streamId; }
  function getThumb(streamId) {
    try { return localStorage.getItem(getThumbKey(streamId)); } catch (e) { return null; }
  }
  function saveThumb(streamId, dataUrl) {
    try { localStorage.setItem(getThumbKey(streamId), dataUrl); } catch (e) {}
  }
  function captureThumbFromVideo(streamId, videoEl) {
    try {
      if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 270;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
      saveThumb(streamId, dataUrl);
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // HLS URL BUILDER
  // ════════════════════════════════════════════════════════════
  function buildHlsUrl(stream) {
    let url = stream.hls_url;
    if (!url && stream.stream_key) {
      if (stream.mode === 'camera') url = `${HLS_PATH}/live/${stream.stream_key}/index.m3u8`;
      else url = `${HLS_PATH}/${stream.stream_key}/index.m3u8`;
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
        .select('id,title,status,mode,stream_key,hls_url,is_active,actual_start,created_at,broadcaster_name,views_count,likes_count,comments_count,is_free,price')
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
    } catch (err) { console.warn(err); }
  }

  function renderAll() {
    const liveCount = $('liveCount');
    if (liveCount) liveCount.textContent = liveStreams.length;
    document.title = liveStreams.length > 0 ? `🔴 LIVE (${liveStreams.length}) | Akimark` : 'Live | Akimark';

    const grid = $('liveGrid');
    const empty = $('emptyState');
    if (!grid) return;

    if (liveStreams.length === 0) {
      grid.innerHTML = '';
      if (empty) empty.style.display = 'block';
    } else {
      if (empty) empty.style.display = 'none';
      grid.innerHTML = liveStreams.map((s, i) => cardHTML(s, true, i)).join('');
      grid.querySelectorAll('.live-card').forEach((el) => {
        el.addEventListener('click', () => openStream(el.dataset.id, true));
      });
    }

    const prevSection = $('previousSection');
    const prevGrid = $('previousGrid');
    if (previousStreams.length > 0 && prevSection && prevGrid) {
      prevSection.style.display = 'block';
      const pc = $('prevCount');
      if (pc) pc.textContent = previousStreams.length;
      prevGrid.innerHTML = previousStreams.map((s, i) => cardHTML(s, false, i)).join('');
      prevGrid.querySelectorAll('.live-card').forEach((el) => {
        el.addEventListener('click', () => openStream(el.dataset.id, false));
      });
    } else if (prevSection) {
      prevSection.style.display = 'none';
    }
  }

  function cardHTML(s, isLive, idx) {
    const isFree = s.is_free !== false;
    const priceLabel = isFree ? 'Free' : formatMWK(s.price);
    const priceClass = isFree ? 'free' : 'paid';
    const views = s.views_count || 0;
    const broadcaster = s.broadcaster_name || 'Akimark';
    const av = initials(broadcaster);
    const thumb = getThumb(s.id);
    const timeRef = isLive ? (s.actual_start || s.created_at) : (s.actual_end || s.actual_start || s.created_at);

    return `
      <div class="live-card ${isLive ? 'is-live' : ''}" data-id="${s.id}" style="animation-delay:${idx * 0.05}s">
        <div class="live-thumb">
          ${thumb ? `<img src="${thumb}" alt="">` : `<div class="live-thumb-fallback"><svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="17 2 12 7 7 2"/></svg></div>`}
          <span class="${isLive ? 'badge-live' : 'badge-ended'}">${isLive ? 'Live' : 'Ended'}</span>
          <span class="badge-views">
            <svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            ${views}
          </span>
          <span class="badge-price ${priceClass}">${escHtml(priceLabel)}</span>
        </div>
        <div class="live-info">
          <div class="live-title">${escHtml(s.title || 'Live Stream')}</div>
          <div class="live-meta">
            <div class="avatar">${escHtml(av)}</div>
            <span>${escHtml(broadcaster)}</span>
            <span class="time">${isLive ? 'Live now' : formatTime(timeRef)}</span>
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
    currentStream = stream;

    const modal = $('streamModal');
    if (!modal) return;

    // Reset UI
    const modalTitle = $('modalTitle');
    if (modalTitle) modalTitle.textContent = stream.title || 'Live Stream';
    const modalBroadcaster = $('modalBroadcaster');
    const modalAvatar = $('modalAvatar');
    if (modalBroadcaster) modalBroadcaster.textContent = stream.broadcaster_name || 'Akimark';
    if (modalAvatar) modalAvatar.textContent = initials(stream.broadcaster_name || 'Akimark');
    const modalStartedAt = $('modalStartedAt');
    if (modalStartedAt) modalStartedAt.textContent = (isLive ? 'Started ' : 'Ended ') + formatFullTime(stream.actual_start || stream.created_at);
    const modalViews = $('modalViews');
    if (modalViews) modalViews.textContent = stream.views_count || 0;
    const modalLikes = $('modalLikes');
    if (modalLikes) modalLikes.textContent = stream.likes_count || 0;
    const liveViews = $('liveViews');
    if (liveViews) liveViews.textContent = stream.views_count || 0;

    // Stream label
    const label = $('streamLabel');
    if (label) {
      label.textContent = isLive ? 'Live' : 'Ended';
      label.classList.toggle('ended', !isLive);
    }

    // Like button state
    const liked = likedStreams[stream.id] === true;
    const likeBtn = $('likeBtn');
    const likeBtnCount = $('likeBtnCount');
    if (likeBtn) likeBtn.classList.toggle('liked', liked);
    if (likeBtnCount) likeBtnCount.textContent = liked ? 'Liked' : 'Like';

    // Show welcome overlay
    const welcome = $('welcomeOverlay');
    if (welcome) welcome.classList.remove('hide');

    // Show unmute prompt hidden initially
    const unmute = $('unmutePrompt');
    if (unmute) unmute.classList.remove('show');

    // Empty chat
    const chatList = $('chatList');
    if (chatList) chatList.innerHTML = '<div class="chat-empty">Be the first to say something 👋</div>';

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Auto-hide controls initially
    setTimeout(() => hideControls(), 3000);

    retryCount = 0;
    attachHls(stream, isLive);
    if (isLive) incrementView(stream.id);
    startStatsPolling(stream.id, isLive);
    subscribeComments(stream.id);
  }

  // ════════════════════════════════════════════════════════════
  // ATTACH HLS
  // ════════════════════════════════════════════════════════════
  async function attachHls(stream, isLive) {
    const hlsUrl = buildHlsUrl(stream);
    const video = $('streamVideo');
    if (!video) return;

    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    try { video.pause(); } catch (e) {}
    video.removeAttribute('src');
    try { video.load(); } catch (e) {}

    if (!hlsUrl) {
      const welcome = $('welcomeOverlay');
      if (welcome) welcome.classList.add('hide');
      return;
    }

    // Pre-check (fast, only 5 fast retries instead of 12)
    try {
      const res = await fetch(hlsUrl, { method: 'GET', mode: 'cors', credentials: 'include', cache: 'no-store' });
      if (res.status === 404 || res.status >= 500) {
        retryCount++;
        if (retryCount <= 5) {
          const welcome = $('welcomeOverlay');
          if (welcome) {
            const sub = welcome.querySelector('.welcome-sub');
            if (sub) sub.textContent = 'Almost there…';
          }
          retryTimer = setTimeout(() => attachHls(stream, isLive), 1500);
        } else {
          const welcome = $('welcomeOverlay');
          if (welcome) {
            const sub = welcome.querySelector('.welcome-sub');
            if (sub) sub.textContent = 'Stream unavailable';
          }
        }
        return;
      }
    } catch (e) {
      // Continue — hls.js may still succeed
    }

    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 45,
        maxMaxBufferLength: 90,
        maxBufferSize: 90 * 1000 * 1000,
        maxBufferHole: 1.0,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        liveDurationInfinity: true,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 10,
        highBufferWatchdogPeriod: 2,
        abrEwmaDefaultEstimate: 500000,       // 🔑 500kbps — better for slow networks
        abrBandWidthFactor: 0.9,
        abrBandWidthUpFactor: 0.7,
        startLevel: -1,
        capLevelToPlayerSize: true,           // 🔑 cap to screen size
        fragLoadingMaxRetry: 6,
        fragLoadingMaxRetryTimeout: 40000,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 4,
        levelLoadingMaxRetryTimeout: 20000,
        enableWorker: true,
        xhrSetup: function (xhr) { xhr.withCredentials = true; },
      });

      let hasStarted = false;
      let lastProgressAt = Date.now();
      let recoveryAttempts = 0;
      let stallDisabled = false;

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        // Try to play with sound
        video.muted = false;
        video.volume = 1;
        const p = video.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            // Autoplay with sound blocked — start muted, show prompt
            video.muted = true;
            video.play().then(() => {
              const unmute = $('unmutePrompt');
              if (unmute) unmute.classList.add('show');
            }).catch(() => {});
          });
        }
      });

      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          const playing = video && !video.paused && video.readyState >= 2 && video.currentTime > 0;
          if (playing) {
            try { hls.startLoad(); } catch (e) {}
          } else {
            setTimeout(() => { try { hls.startLoad(); } catch (e) {} }, 1200);
          }
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch (e) {}
        } else {
          stallDisabled = true;
        }
      });

      // Video events
      video.addEventListener('playing', () => {
        hasStarted = true;
        lastProgressAt = Date.now();
        recoveryAttempts = 0;
        // Hide welcome
        const welcome = $('welcomeOverlay');
        if (welcome) welcome.classList.add('hide');
        // Capture thumbnail
        setTimeout(() => captureThumbFromVideo(stream.id, video), 800);
        // Update play button
        updatePlayPauseUI();
      });

      video.addEventListener('timeupdate', () => {
        lastProgressAt = Date.now();
        if (recoveryAttempts > 0) recoveryAttempts = 0;
        if (!hasStarted) hasStarted = true;
        // Hide welcome if still showing
        const welcome = $('welcomeOverlay');
        if (welcome && !welcome.classList.contains('hide')) {
          if (!video.paused && video.readyState >= 2 && video.currentTime > 0.5) {
            welcome.classList.add('hide');
          }
        }
        // Update progress
        const pf = $('progressFill');
        if (pf && isLive) pf.classList.add('live');
      });

      video.addEventListener('pause', updatePlayPauseUI);
      video.addEventListener('play', updatePlayPauseUI);

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      // Watchdog
      if (attachHls._wd) clearInterval(attachHls._wd);
      attachHls._wd = setInterval(() => {
        if (!hls || !video || !isLive) return;
        if (stallDisabled) return;
        if (!hasStarted) return;
        if (video.paused || video.ended) return;

        const since = Date.now() - lastProgressAt;
        if (since > 3000) {
          recoveryAttempts++;
          if (recoveryAttempts === 1) { try { hls.startLoad(); } catch (e) {} }
          else if (recoveryAttempts <= 3) {
            try {
              const b = video.buffered;
              if (b.length > 0) {
                const lastEnd = b.end(b.length - 1);
                if (lastEnd > video.currentTime + 0.5) {
                  video.currentTime = lastEnd - 0.5;
                  video.play().catch(() => {});
                }
              }
            } catch (e) {}
          } else {
            try {
              const b = video.buffered;
              if (b.length > 0) {
                const edge = b.end(b.length - 1);
                video.currentTime = Math.max(0, edge - 1.5);
                video.play().catch(() => {});
              }
            } catch (e) {}
          }
          lastProgressAt = Date.now();
        }
      }, 1500);

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.crossOrigin = 'use-credentials';
      video.addEventListener('loadedmetadata', () => {
        video.muted = false;
        video.play().catch(() => {
          video.muted = true;
          video.play().then(() => {
            const unmute = $('unmutePrompt');
            if (unmute) unmute.classList.add('show');
          }).catch(() => {});
        });
      }, { once: true });
    }
  }

  function updatePlayPauseUI() {
    const video = $('streamVideo');
    const btn = $('playPauseBtn');
    const big = $('bigPlayBtn');
    if (!video) return;
    const playing = !video.paused && !video.ended;
    if (btn) btn.innerHTML = playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" fill="#fff" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="#fff" stroke="none"/></svg>'
      : '<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" fill="#fff" stroke="none"/></svg>';
    if (big) big.classList.toggle('show', !playing);
  }

  // ════════════════════════════════════════════════════════════
  // VIEWS / LIKES / COMMENTS
  // ════════════════════════════════════════════════════════════
  async function incrementView(liveId) {
    if (!supabase) return;
    try {
      const { data: cur } = await supabase.from('live_videos').select('views_count').eq('id', liveId).maybeSingle();
      const next = (cur?.views_count || 0) + 1;
      await supabase.from('live_videos').update({ views_count: next }).eq('id', liveId);
      updateViewsUI(next);
    } catch (e) {}
  }

  function updateViewsUI(n) {
    const el1 = $('modalViews');
    const el2 = $('liveViews');
    if (el1) el1.textContent = n;
    if (el2) el2.textContent = n;
  }

  function updateLikesUI(n) {
    const el1 = $('modalLikes');
    if (el1) el1.textContent = n;
  }

  async function toggleLike() {
    if (!supabase || !currentStream) return;
    const id = currentStream.id;
    const liked = likedStreams[id] === true;

    // Optimistic UI
    const likeBtn = $('likeBtn');
    const likeBtnCount = $('likeBtnCount');
    const stat = $('modalLikesStat');

    if (liked) {
      delete likedStreams[id];
      if (likeBtn) likeBtn.classList.remove('liked');
      if (likeBtnCount) likeBtnCount.textContent = 'Like';
      if (stat) stat.classList.remove('likes-active');
    } else {
      likedStreams[id] = true;
      if (likeBtn) likeBtn.classList.add('liked');
      if (likeBtnCount) likeBtnCount.textContent = 'Liked';
      if (stat) stat.classList.add('likes-active');
      // Spawn heart emoji
      spawnEmoji('❤️');
    }
    localStorage.setItem('akmark_liked', JSON.stringify(likedStreams));

    // Update DB
    try {
      const { data: cur } = await supabase.from('live_videos').select('likes_count').eq('id', id).maybeSingle();
      const current = cur?.likes_count || 0;
      const next = liked ? Math.max(0, current - 1) : current + 1;
      await supabase.from('live_videos').update({ likes_count: next }).eq('id', id);
      updateLikesUI(next);
      if (currentStream) currentStream.likes_count = next;
    } catch (e) {}
  }

  async function postComment(text) {
    if (!supabase || !currentStream || !text) return;
    const liveId = currentStream.id;
    try {
      const { data, error } = await supabase.from('live_comments').insert({
        live_id: liveId,
        user_id: USER_ID,
        user_name: USER_NAME,
        message: text,
      }).select().single();
      if (error) throw error;

      // Update comments_count
      const { data: cur } = await supabase.from('live_videos').select('comments_count').eq('id', liveId).maybeSingle();
      const next = (cur?.comments_count || 0) + 1;
      await supabase.from('live_videos').update({ comments_count: next }).eq('id', liveId);

      // Append to chat immediately
      appendComment({ user_name: USER_NAME, message: text, created_at: new Date().toISOString() });
    } catch (e) {
      showToast('Comment failed — check DB schema');
    }
  }

  function appendComment(c) {
    const chatList = $('chatList');
    if (!chatList) return;
    // Remove empty state
    const empty = chatList.querySelector('.chat-empty');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.className = 'chat-item';
    div.innerHTML = `
      <div class="chat-avatar">${escHtml(initials(c.user_name || 'V'))}</div>
      <div class="chat-body">
        <div class="chat-user">${escHtml(c.user_name || 'Viewer')}</div>
        <div class="chat-msg">${escHtml(c.message || '')}<span class="chat-time">${formatTime(c.created_at)}</span></div>
      </div>`;
    chatList.appendChild(div);
    chatList.scrollTop = chatList.scrollHeight;
  }

  async function loadComments(liveId) {
    if (!supabase) return;
    try {
      const { data } = await supabase
        .from('live_comments')
        .select('id,user_name,message,created_at')
        .eq('live_id', liveId)
        .order('created_at', { ascending: false })
        .limit(50);
      const chatList = $('chatList');
      if (!chatList) return;
      if (!data || data.length === 0) {
        chatList.innerHTML = '<div class="chat-empty">Be the first to say something 👋</div>';
        return;
      }
      chatList.innerHTML = data.reverse().map((c) => `
        <div class="chat-item">
          <div class="chat-avatar">${escHtml(initials(c.user_name || 'V'))}</div>
          <div class="chat-body">
            <div class="chat-user">${escHtml(c.user_name || 'Viewer')}</div>
            <div class="chat-msg">${escHtml(c.message || '')}<span class="chat-time">${formatTime(c.created_at)}</span></div>
          </div>
        </div>`).join('');
      chatList.scrollTop = chatList.scrollHeight;
    } catch (e) {}
  }

  function subscribeComments(liveId) {
    if (!supabase) return;
    try {
      if (commentsChannel) { try { commentsChannel.unsubscribe(); } catch (e) {} }
      commentsChannel = supabase.channel('comments_' + liveId)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'live_comments',
          filter: 'live_id=eq.' + liveId,
        }, (payload) => {
          if (payload.new && payload.new.user_id !== USER_ID) {
            appendComment(payload.new);
          }
        })
        .subscribe();
    } catch (e) {}
  }

  function startStatsPolling(liveId, isLive) {
    stopStatsPolling();
    fetchStats(liveId, isLive);
    loadComments(liveId);
    statsPollTimer = setInterval(() => fetchStats(liveId, isLive), 6000);
  }
  function stopStatsPolling() {
    if (statsPollTimer) { clearInterval(statsPollTimer); statsPollTimer = null; }
    if (commentsChannel) { try { commentsChannel.unsubscribe(); } catch (e) {} commentsChannel = null; }
  }

  async function fetchStats(liveId, isLive) {
    if (!supabase) return;
    try {
      const { data: live } = await supabase
        .from('live_videos')
        .select('views_count,likes_count,comments_count,status,is_active')
        .eq('id', liveId).maybeSingle();
      if (!live) return;
      updateViewsUI(live.views_count || 0);
      updateLikesUI(live.likes_count || 0);
      if (isLive && (live.status !== 'live' || live.is_active === false)) {
        const label = $('streamLabel');
        if (label) { label.textContent = 'Ended'; label.classList.add('ended'); }
        if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
        stopStatsPolling();
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════
  // EMOJI REACTIONS
  // ════════════════════════════════════════════════════════════
  function spawnEmoji(emoji) {
    const layer = $('floatingLayer');
    if (!layer) return;
    const el = document.createElement('div');
    el.className = 'floating-emoji';
    el.textContent = emoji;
    el.style.left = (15 + Math.random() * 70) + '%';
    el.style.setProperty('--tx', ((Math.random() - 0.5) * 120).toFixed(0) + 'px');
    layer.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

  // ════════════════════════════════════════════════════════════
  // CONTROLS AUTO-HIDE
  // ════════════════════════════════════════════════════════════
  function showControls() {
    const top = $('playerTop');
    const bot = $('playerBottom');
    const bar = $('emojiBar');
    if (top) top.classList.remove('hide');
    if (bot) bot.classList.remove('hide');
    if (bar) bar.classList.remove('hide');
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
    const video = $('streamVideo');
    if (video && !video.paused) {
      controlsHideTimer = setTimeout(hideControls, 3500);
    }
  }
  function hideControls() {
    const top = $('playerTop');
    const bot = $('playerBottom');
    const bar = $('emojiBar');
    if (top) top.classList.add('hide');
    if (bot) bot.classList.add('hide');
    if (bar) bar.classList.add('hide');
  }

  // ════════════════════════════════════════════════════════════
  // CLOSE
  // ════════════════════════════════════════════════════════════
  function closeStream() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (attachHls._wd) { clearInterval(attachHls._wd); attachHls._wd = null; }
    if (commentsChannel) { try { commentsChannel.unsubscribe(); } catch (e) {} commentsChannel = null; }
    const modal = $('streamModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
    stopStatsPolling();
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    const video = $('streamVideo');
    if (video) {
      try { video.pause(); } catch (e) {}
      video.removeAttribute('src');
      try { video.load(); } catch (e) {}
    }
    currentStream = null;
  }

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════
  function init() {
    // Modal close
    const closeBtn = $('closeBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeStream);
    const modal = $('streamModal');
    // No background close — modal covers full screen

    // Play/pause
    const playPauseBtn = $('playPauseBtn');
    if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlay);
    const bigPlayBtn = $('bigPlayBtn');
    if (bigPlayBtn) bigPlayBtn.addEventListener('click', togglePlay);

    // Center tap — show controls or toggle play
    const wrap = $('playerWrap');
    if (wrap) {
      wrap.addEventListener('click', (e) => {
        // Ignore clicks on controls / emojis / unmute prompt
        if (e.target.closest('button') || e.target.closest('.unmute-prompt') || e.target.closest('.emoji-bar')) return;
        const video = $('streamVideo');
        const top = $('playerTop');
        if (top && top.classList.contains('hide')) {
          showControls();
        } else {
          // Hide then toggle
          hideControls();
        }
      });
    }

    // Mute toggle
    const muteBtn = $('muteBtn');
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        const video = $('streamVideo');
        if (!video) return;
        video.muted = !video.muted;
        updateMuteUI();
        showControls();
      });
    }

    // Unmute prompt
    const unmute = $('unmutePrompt');
    if (unmute) {
      unmute.addEventListener('click', () => {
        const video = $('streamVideo');
        if (!video) return;
        video.muted = false;
        video.volume = 1;
        video.play().catch(() => {});
        unmute.classList.remove('show');
        updateMuteUI();
      });
    }

    // Fullscreen
    const fsBtn = $('fullscreenBtn');
    if (fsBtn) {
      fsBtn.addEventListener('click', () => {
        const el = $('playerWrap');
        if (!el) return;
        if (!document.fullscreenElement) {
          (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el);
        } else {
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        }
      });
    }

    // Like
    const likeBtn = $('likeBtn');
    if (likeBtn) likeBtn.addEventListener('click', toggleLike);

    // Share
    const shareBtn = $('shareBtn');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
        if (!currentStream) return;
        const url = location.origin + '/live.html';
        try {
          if (navigator.share) {
            await navigator.share({ title: currentStream.title, url });
          } else {
            await navigator.clipboard.writeText(url);
            showToast('Link copied 📋');
          }
        } catch (e) {}
      });
    }

    // Emoji bar
    document.querySelectorAll('.emoji-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        spawnEmoji(btn.dataset.emoji || '❤️');
        showControls();
      });
    });

    // Chat form
    const form = $('chatForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('chatInput');
        if (!input) return;
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        postComment(text);
      });
    }

    // ESC to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeStream();
    });

    // Video event listeners
    const video = $('streamVideo');
    if (video) {
      video.addEventListener('pause', updatePlayPauseUI);
      video.addEventListener('play', updatePlayPauseUI);
      video.addEventListener('volumechange', updateMuteUI);
    }

    // Load
    loadAll();
    if (loadTimer) clearInterval(loadTimer);
    loadTimer = setInterval(loadAll, 20000);

    // Realtime new live streams
    if (supabase) {
      try {
        supabase.channel('live_videos_public_v16')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'live_videos' }, () => loadAll())
          .subscribe(() => {});
      } catch (e) {}
    }

    window.addEventListener('beforeunload', () => {
      if (hls) { try { hls.destroy(); } catch (e) {} }
      if (attachHls._wd) { clearInterval(attachHls._wd); }
      stopStatsPolling();
      if (loadTimer) clearInterval(loadTimer);
      if (retryTimer) clearTimeout(retryTimer);
    });
  }

  function togglePlay() {
    const video = $('streamVideo');
    if (!video) return;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
    updatePlayPauseUI();
    showControls();
  }

  function updateMuteUI() {
    const video = $('streamVideo');
    const btn = $('muteBtn');
    if (!video || !btn) return;
    if (video.muted) {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    } else {
      btn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

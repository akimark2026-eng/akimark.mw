// watch.js (v3 — direct MP4, pre-check response, pro diagnostics)
(function() {
    'use strict';

    const BUILD_VERSION = 'v20260923-3';
    console.log(`[Akimark] watch.js ${BUILD_VERSION} loaded`);

    const SUPABASE_URL = window.SUPABASE_URL || 'https://jnqwvmxuieeelvukhcsq.supabase.co';
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
    const movieId = new URLSearchParams(window.location.search).get('id');

    if (!movieId) { showError('Missing movie ID'); return; }

    // ================== DOWNLOAD MANAGER DETECTION ==================
    const DM_PATTERNS = [
        /1dm/i, /\bidm\b/i, /internet\s*download\s*manager/i, /\bxdm\b/i,
        /xtreme\s*download/i, /\bfdm\b/i, /free\s*download\s*manager/i,
        /flashget/i, /jdownloader/i, /mipony/i, /eagleget/i, /aria2/i,
        /\bwget\b/i, /\bcurl\b/i, /download\s*manager/i, /video\s*downloader/i,
        /savefrom/i, /ytdl/i
    ];
    function isDownloadManagerUA() {
        const ua = (navigator.userAgent || '').toLowerCase();
        return DM_PATTERNS.some(p => p.test(ua));
    }
    if (isDownloadManagerUA()) {
        document.body.innerHTML = `
            <div style="position:fixed;inset:0;background:#0b0b0f;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;text-align:center;padding:20px;">
                <div style="font-size:4rem;margin-bottom:15px;">🚫</div>
                <h1 style="color:#c71515;">Access Denied</h1>
                <p style="color:#aaa;margin-top:10px;">Download managers are not allowed on this platform.</p>
            </div>`;
        throw new Error('Download Manager blocked');
    }

    // ================== DOM ==================
    const playerContainer = document.getElementById('player-container');
    const video = document.getElementById('video');
    const loader = document.getElementById('loader');
    const controls = document.getElementById('controls');
    const centerPlayBtn = document.getElementById('centerPlayBtn');
    const playPauseBtn = document.getElementById('playPauseBtn');
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const muteBtn = document.getElementById('muteBtn');
    const muteIcon = document.getElementById('muteIcon');
    const unmuteIcon = document.getElementById('unmuteIcon');
    const backwardBtn = document.getElementById('backwardBtn');
    const forwardBtn = document.getElementById('forwardBtn');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const progressThumb = document.getElementById('progressThumb');
    const currentTimeEl = document.getElementById('currentTime');
    const durationTimeEl = document.getElementById('durationTime');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const speedBtn = document.getElementById('speedBtn');
    const speedOptions = document.getElementById('speedOptions');
    const exitBtn = document.getElementById('exitBtn');
    const rotateBtn = document.getElementById('rotateBtn');

    let controlsTimeout = null;
    let isSeeking = false;
    let expireTime = null;
    let expireTimeout = null;
    let isExpired = false;
    let lastSaveTime = 0;
    let currentClientKey = null;
    let sessionRefreshTimer = null;

    const RESUME_KEY = 'akimark_resume_' + movieId;
    const ROTATE_KEY = 'akimark_rotate_' + movieId;

    // ================== HMAC-SHA256 ==================
    async function hmacSha256Hex(secret, message) {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const sig = await crypto.subtle.sign(
            'HMAC', key, new TextEncoder().encode(message),
        );
        return Array.from(new Uint8Array(sig))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ================== PRE-CHECK: Verify URL returns video, not JSON ==================
    async function preflightVideoUrl(url) {
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                headers: {
                    'Accept': 'video/*,*/*',
                },
            });

            const ct = res.headers.get('Content-Type') || '';
            const debugReason = res.headers.get('X-Debug-Reason') || '';
            const len = res.headers.get('Content-Length') || '0';

            console.log('[Akimark] Preflight:', {
                status: res.status,
                contentType: ct,
                contentLength: len,
                debugReason,
            });

            if (!res.ok) {
                // Try to read body to get error reason
                let bodyErr = '';
                try {
                    const txt = await res.text();
                    bodyErr = txt.slice(0, 300);
                } catch {}
                throw new Error(
                    `HTTP ${res.status} | Debug: ${debugReason} | Body: ${bodyErr}`
                );
            }

            if (ct.includes('json')) {
                let bodyErr = '';
                try {
                    const txt = await res.text();
                    bodyErr = txt.slice(0, 300);
                } catch {}
                throw new Error(
                    `Worker returned JSON instead of video!\n` +
                    `Content-Type: ${ct}\n` +
                    `Debug-Reason: ${debugReason}\n` +
                    `Body: ${bodyErr}`
                );
            }

            if (!ct.startsWith('video/') && !ct.includes('octet-stream')) {
                throw new Error(
                    `Unexpected Content-Type: "${ct}" (expected video/mp4)\n` +
                    `Debug-Reason: ${debugReason}`
                );
            }

            return { ok: true, contentType: ct, contentLength: len };
        } catch (err) {
            if (err.name === 'TypeError' || err.message.includes('Failed to fetch')) {
                throw new Error(
                    `Preflight network failure — Worker siyikuyankha.\n` +
                    `URL: ${url.slice(0, 140)}...\n` +
                    `Yambani: Yang'anani Cloudflare Worker route ndi DNS.`
                );
            }
            throw err;
        }
    }

    // ================== VIDEO ATTACH ==================
    function detachVideo() {
        try { video.pause(); } catch {}
        video.removeAttribute('src');
        try { video.load(); } catch {}
    }

    function attachVideo(url, opts = {}) {
        const { label = 'video', maxRetries = 2 } = opts;
        detachVideo();
        video.src = url;
        video.load();

        return new Promise((resolve, reject) => {
            let settled = false;
            let lastProgressAt = Date.now();
            let retries = 0;

            const STALL_MS = 20000;
            const ABSOLUTE_MAX_MS = 5 * 60 * 1000;

            const settle = (fn, val) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(val);
            };

            const onMeta = () => {
                const seconds = Math.round((Date.now() - startedAt) / 1000);
                console.log(`[Akimark] ✅ ${label} metadata ready in ${seconds}s`);
                settle(resolve);
            };
            const onErr = () => {
                const err = video.error;
                const codeMap = {
                    1: 'MEDIA_ERR_ABORTED',
                    2: 'MEDIA_ERR_NETWORK',
                    3: 'MEDIA_ERR_DECODE',
                    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
                };
                const code = err ? codeMap[err.code] || `CODE_${err.code}` : 'UNKNOWN';
                const msg = err?.message || 'Video element error';
                settle(reject, new Error(`${label} failed: ${code} — ${msg}`));
            };
            const onProgress = () => { lastProgressAt = Date.now(); };
            const onLoadedStart = () => { lastProgressAt = Date.now(); };
            const onWaiting = () => { lastProgressAt = Date.now(); };

            const startedAt = Date.now();
            const stallTimer = setInterval(() => {
                if (settled) return;
                const stalledFor = Date.now() - lastProgressAt;
                const totalElapsed = Date.now() - startedAt;

                if (video.readyState >= 1) return;

                if (stalledFor > STALL_MS) {
                    if (retries < maxRetries) {
                        retries++;
                        console.warn(`[Akimark] ${label} stalled — retry ${retries}/${maxRetries}`);
                        lastProgressAt = Date.now();
                        video.load();
                        return;
                    }
                    settle(reject, new Error(
                        `${label} stalled — palibe data kwa ${Math.round(stalledFor/1000)}s.\n` +
                        `readyState: ${video.readyState}, networkState: ${video.networkState}`
                    ));
                }
                if (totalElapsed > ABSOLUTE_MAX_MS) {
                    settle(reject, new Error(`${label} hard cap exceeded`));
                }
            }, 1000);

            function cleanup() {
                clearInterval(stallTimer);
                video.removeEventListener('loadedmetadata', onMeta);
                video.removeEventListener('error', onErr);
                video.removeEventListener('progress', onProgress);
                video.removeEventListener('loadstart', onLoadedStart);
                video.removeEventListener('waiting', onWaiting);
            }

            video.addEventListener('loadedmetadata', onMeta);
            video.addEventListener('error', onErr);
            video.addEventListener('progress', onProgress);
            video.addEventListener('loadstart', onLoadedStart);
            video.addEventListener('waiting', onWaiting);
        });
    }

    // ================== SESSION API ==================
    const userToken = localStorage.getItem('akmark_token');

    async function getStreamSession(videoId) {
        const res = await fetch(
            `${SUPABASE_URL}/functions/v1/player-session-api`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
                    ...(userToken ? { 'X-User-Token': userToken } : {}),
                },
                body: JSON.stringify({ video_id: videoId }),
            }
        );
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { error: text }; }
        if (!res.ok) {
            throw new Error(
                `Session API (${res.status})\n` +
                (data.error ? `Error: ${data.error}\n` : '') +
                (data.message ? `Message: ${data.message}\n` : '')
            );
        }
        return data;
    }

    // ================== ANTI-DOWNLOAD HARDENING ==================
    function hardenVideoElement() {
        video.setAttribute('controlsList', 'nodownload noplaybackrate noremoteplayback');
        video.setAttribute('disablePictureInPicture', 'true');
        video.setAttribute('disableRemotePlayback', 'true');
        video.setAttribute('playsinline', 'true');
        video.removeAttribute('download');

        video.addEventListener('contextmenu', e => e.preventDefault());
        playerContainer.addEventListener('contextmenu', e => e.preventDefault());
        video.addEventListener('dragstart', e => e.preventDefault());
        video.addEventListener('touchstart', e => {
            if (e.touches.length > 1) e.preventDefault();
        }, { passive: false });
    }

    // ================== WATERMARK ==================
    function createWatermark() {
        let label = 'AKIMARK';
        try {
            const u = JSON.parse(localStorage.getItem('akmark_user') || '{}');
            label = u.email || u.phone || u.username || u.user_id || label;
        } catch (e) {}

        const wm = document.createElement('div');
        wm.id = 'videoWatermark';
        wm.textContent = label + ' • ' + new Date().toISOString().slice(0, 16).replace('T', ' ');
        wm.style.cssText = `
            position: absolute;
            color: rgba(255,255,255,0.18);
            font-size: 12px;
            font-weight: bold;
            pointer-events: none;
            user-select: none;
            z-index: 15;
            font-family: monospace;
            letter-spacing: 1px;
            text-shadow: 0 0 2px rgba(0,0,0,0.6);
            transition: top 0.8s ease, left 0.8s ease;
            top: 15%;
            left: 10%;
        `;
        playerContainer.appendChild(wm);

        setInterval(() => {
            if (!wm.parentNode) return;
            wm.style.top = (Math.random() * 70 + 10) + '%';
            wm.style.left = (Math.random() * 70 + 10) + '%';
        }, 12000);
    }

    // ================== RESUME ==================
    function saveResumeTime(force) {
        if (isExpired) return;
        const current = video.currentTime || 0;
        const now = Date.now();
        if (force || now - lastSaveTime > 2000) {
            localStorage.setItem(RESUME_KEY, JSON.stringify({
                time: current, timestamp: now, duration: video.duration || 0
            }));
            lastSaveTime = now;
        }
    }
    function loadResumeTime() {
        const stored = localStorage.getItem(RESUME_KEY);
        if (!stored) return 0;
        try {
            const data = JSON.parse(stored);
            if (data.time && data.duration && data.time < data.duration - 5) return data.time;
        } catch (e) {}
        return 0;
    }

    // ================== ROTATE ==================
    function loadRotation() {
        applyRotation(parseInt(localStorage.getItem(ROTATE_KEY) || '0'));
    }
    function applyRotation(deg) {
        video.style.transform = `rotate(${deg}deg)`;
        localStorage.setItem(ROTATE_KEY, deg.toString());
    }
    function rotate() {
        let current = parseInt(localStorage.getItem(ROTATE_KEY) || '0');
        current = (current + 90) % 360;
        applyRotation(current);
    }

    // ================== EXPIRY ==================
    function createExpiryOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'expiryOverlay';
        overlay.style.cssText = `
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.85); display: flex; flex-direction: column;
            align-items: center; justify-content: center; z-index: 20;
            text-align: center; padding: 20px; color: #fff;
        `;
        overlay.innerHTML = `
            <div style="font-size: 3rem; margin-bottom: 10px;">⏱️</div>
            <h2 style="margin-bottom: 10px;">Access Expired</h2>
            <p style="color: #aaa; margin-bottom: 20px;">Your viewing time has ended. Please purchase again to continue watching.</p>
            <button onclick="window.location.href='my-movies.html'" style="background: #c71515; color: #fff; border: none; padding: 12px 24px; border-radius: 8px; font-size: 1rem; cursor: pointer;">Go to My Movies</button>
        `;
        playerContainer.appendChild(overlay);
        return overlay;
    }
    function onExpire() {
        isExpired = true;
        video.pause();
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
        centerPlayBtn.classList.add('hidden');
        controls.style.pointerEvents = 'none';
        localStorage.removeItem(RESUME_KEY);
        let overlay = document.getElementById('expiryOverlay');
        if (!overlay) overlay = createExpiryOverlay();
        overlay.style.display = 'flex';
    }

    // ================== SCRUBBER ==================
    progressBar.addEventListener('pointerdown', (e) => {
        if (isExpired) return;
        isSeeking = true;
        updateSeek(e);
        progressBar.setPointerCapture(e.pointerId);
        showControls();
    });
    progressBar.addEventListener('pointermove', (e) => {
        if (isSeeking && !isExpired) updateSeek(e);
    });
    progressBar.addEventListener('pointerup', () => {
        isSeeking = false;
        showControls();
    });

    function updateSeek(e) {
        const rect = progressBar.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.min(1, Math.max(0, x / rect.width));
        if (video.duration) video.currentTime = percent * video.duration;
        progressFill.style.width = `${percent * 100}%`;
        progressThumb.style.left = `${percent * 100}%`;
        currentTimeEl.textContent = formatTime(video.currentTime);
    }

    // ================== TAP ==================
    let tapStartX = 0, tapStartY = 0, tapStartTime = 0;
    playerContainer.addEventListener('pointerdown', (e) => {
        if (isExpired) return;
        if (e.target.closest('.controls') || e.target.closest('#centerPlayBtn') || e.target.closest('#exitBtn') || e.target.closest('#rotateBtn')) return;
        tapStartX = e.clientX; tapStartY = e.clientY; tapStartTime = Date.now();
    });
    playerContainer.addEventListener('pointerup', (e) => {
        if (isExpired) return;
        if (e.target.closest('.controls') || e.target.closest('#centerPlayBtn') || e.target.closest('#exitBtn') || e.target.closest('#rotateBtn')) return;
        const dx = e.clientX - tapStartX, dy = e.clientY - tapStartY, dt = Date.now() - tapStartTime;
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 500) {
            if (controls.classList.contains('visible')) controls.classList.remove('visible');
            else showControls();
        }
    });

    // ================== INIT ==================
    async function init() {
        showLoader(true);
        centerPlayBtn.classList.add('hidden');
        loadRotation();
        hardenVideoElement();
        createWatermark();

        try {
            console.log('[Akimark] Requesting session…');
            const session = await getStreamSession(movieId);
            console.log('[Akimark] Session OK:', {
                expiresIn: session.expiresIn,
                streamUrl: session.streamUrl?.slice(0, 140) + '...',
            });

            currentClientKey = session.clientKey || null;

            if (session.streamUrl && session.streamUrl.includes('.m3u8')) {
                throw new Error(
                    `🔴 Session API ikubweletsa HLS URL (m3u8)!\n` +
                    `URL: ${session.streamUrl}`
                );
            }

            // ═══ PREFLIGHT: Check that worker returns video, not JSON ═══
            console.log('[Akimark] Preflighting video URL…');
            const pre = await preflightVideoUrl(session.streamUrl);
            console.log('[Akimark] ✅ Preflight OK:', pre);

            // ═══ Attach ═══
            console.log('[Akimark] Attaching video stream…');
            await attachVideo(session.streamUrl, { label: 'video' });
            console.log('[Akimark] ✅ Video attached successfully');

            if (session.expiresIn) {
                expireTime = Date.now() + (session.expiresIn * 1000);
                const remaining = expireTime - Date.now();
                if (remaining <= 0) onExpire();
                else expireTimeout = setTimeout(onExpire, remaining);
                scheduleSessionRefresh(session.expiresIn);
            }

            video.play().catch(() => {
                if (!isExpired) centerPlayBtn.classList.remove('hidden');
            });
            showControls();
        } catch (err) {
            console.error('[Akimark] ❌ Init error:', err);
            showDetailedError(err);
        }
    }

    // ================== SESSION REFRESH ==================
    function scheduleSessionRefresh(expiresIn) {
        if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
        const refreshMs = Math.max((expiresIn - 120) * 1000, 60_000);

        sessionRefreshTimer = setTimeout(async () => {
            try {
                console.log('[Akimark] Refreshing session…');
                const fresh = await getStreamSession(movieId);
                currentClientKey = fresh.clientKey || currentClientKey;

                const wasPlaying = !video.paused;
                const curTime = video.currentTime;
                const wasMuted = video.muted;

                await preflightVideoUrl(fresh.streamUrl);
                await attachVideo(fresh.streamUrl, { label: 'video-refresh' });
                await new Promise((res) => {
                    const on = () => { video.removeEventListener('loadedmetadata', on); res(); };
                    video.addEventListener('loadedmetadata', on);
                    setTimeout(res, 5000);
                });
                try { video.currentTime = curTime; } catch {}
                video.muted = wasMuted;

                if (wasPlaying) { try { await video.play(); } catch {} }

                if (fresh.expiresIn) {
                    expireTime = Date.now() + (fresh.expiresIn * 1000);
                    if (expireTimeout) clearTimeout(expireTimeout);
                    expireTimeout = setTimeout(onExpire, fresh.expiresIn * 1000);
                }
                scheduleSessionRefresh(fresh.expiresIn);
            } catch (e) {
                console.error('Session refresh failed:', e);
                sessionRefreshTimer = setTimeout(() => scheduleSessionRefresh(1800), 60_000);
            }
        }, refreshMs);
    }

    // ================== VIDEO EVENTS ==================
    video.addEventListener('loadedmetadata', () => {
        durationTimeEl.textContent = formatTime(video.duration);
        const resumeTime = loadResumeTime();
        if (resumeTime > 0 && resumeTime < video.duration - 5) {
            video.currentTime = resumeTime;
        }
        updateProgress();
        showLoader(false);
    });

    video.addEventListener('timeupdate', () => {
        if (isExpired) return;
        updateProgress();
        saveResumeTime(false);
        if (expireTime && Date.now() > expireTime) onExpire();
    });

    video.addEventListener('play', () => {
        if (isExpired) { video.pause(); return; }
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
        centerPlayBtn.classList.add('hidden');
        showLoader(false);
    });

    video.addEventListener('pause', () => {
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
        if (!isExpired) centerPlayBtn.classList.remove('hidden');
        saveResumeTime(true);
    });

    video.addEventListener('waiting', () => showLoader(true));
    video.addEventListener('playing', () => showLoader(false));
    video.addEventListener('ended', () => {
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
        centerPlayBtn.classList.remove('hidden');
        localStorage.removeItem(RESUME_KEY);
    });

    // ================== CONTROLS ==================
    playPauseBtn.addEventListener('click', () => {
        if (isExpired) return;
        if (video.paused) video.play(); else video.pause();
        showControls();
    });
    muteBtn.addEventListener('click', () => {
        if (isExpired) return;
        video.muted = !video.muted;
        muteIcon.style.display = video.muted ? 'none' : 'block';
        unmuteIcon.style.display = video.muted ? 'block' : 'none';
        showControls();
    });
    backwardBtn.addEventListener('click', () => {
        if (isExpired) return;
        video.currentTime = Math.max(0, video.currentTime - 10);
        showControls();
    });
    forwardBtn.addEventListener('click', () => {
        if (isExpired) return;
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
        showControls();
    });
    fullscreenBtn.addEventListener('click', toggleFullscreen);

    speedBtn.addEventListener('click', (e) => {
        if (isExpired) return;
        e.stopPropagation();
        speedOptions.classList.toggle('show');
        showControls();
    });
    speedOptions.querySelectorAll('.speed-option').forEach(option => {
        option.addEventListener('click', (e) => {
            if (isExpired) return;
            e.stopPropagation();
            const speed = parseFloat(option.dataset.speed);
            video.playbackRate = speed;
            speedBtn.textContent = `${speed}x`;
            speedOptions.querySelectorAll('.speed-option').forEach(o => o.classList.remove('active'));
            option.classList.add('active');
            speedOptions.classList.remove('show');
            showControls();
        });
    });
    centerPlayBtn.addEventListener('click', () => {
        if (isExpired) return;
        video.play();
        showControls();
    });
    exitBtn.addEventListener('click', () => {
        saveResumeTime(true);
        detachVideo();
        currentClientKey = null;
        window.location.href = 'my-movies.html';
    });
    rotateBtn.addEventListener('click', () => {
        if (isExpired) return;
        rotate();
        showControls();
    });

    // ================== AUTO-HIDE ==================
    function showControls() {
        if (isExpired) return;
        controls.classList.add('visible');
        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(() => {
            if (!video.paused && !isSeeking && !isExpired) controls.classList.remove('visible');
        }, 3000);
    }
    document.addEventListener('click', (e) => {
        if (!speedOptions.contains(e.target) && e.target !== speedBtn) {
            speedOptions.classList.remove('show');
        }
    });

    // ================== HELPERS ==================
    function updateProgress() {
        const percent = (video.currentTime / video.duration) * 100;
        progressFill.style.width = `${percent}%`;
        progressThumb.style.left = `${percent}%`;
        currentTimeEl.textContent = formatTime(video.currentTime);
    }
    function formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
    }
    function showLoader(show) { loader.style.display = show ? 'block' : 'none'; }
    function toggleFullscreen() {
        const c = document.getElementById('player-container');
        if (!document.fullscreenElement) c.requestFullscreen();
        else document.exitFullscreen();
    }

    function showError(message) {
        const container = document.getElementById('player-container');
        container.innerHTML = `<div class="error-state"><h2>Error</h2><p>${String(message).replace(/\n/g, '<br>')}</p><button onclick="window.location.href='/'">Go Home</button></div>`;
    }

    function showDetailedError(err) {
        const msg = err?.message || String(err);
        let diagnostic = '';

        if (msg.includes('HLS')) {
            diagnostic = '🔴 watch.js wakale ukugwirabe ntchito (cache). Hard refresh.';
        } else if (msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('Failed to fetch') || msg.includes('network failure')) {
            diagnostic = '🔴 Cloudflare Worker sakuyankha pa domain ino. Yang\'anani route: <code>apk.akimark.mw/api/player-api/*</code> kapena <code>demo-mode.akimark.mw/api/player-api/*</code>.';
        } else if (msg.includes('Session API')) {
            diagnostic = '🔴 player-session-api ikulephera. Yang\'anani Supabase logs.';
        } else if (msg.includes('JSON instead of video')) {
            diagnostic = '🔴 Worker ikubweletsa JSON (error) m\'malo mwa video. Yang\'anani <code>X-Debug-Reason</code> mu message.';
        } else if (msg.includes('Unexpected Content-Type')) {
            diagnostic = '🔴 Worker ikubweletsa content-type yolakwika. Onani worker logs.';
        } else if (msg.includes('MEDIA_ERR_SRC_NOT_SUPPORTED')) {
            diagnostic = '🔴 Format error — URL siyikubweletsa MP4. Preflight inalephera kapena video URL yolakwika.';
        } else if (msg.includes('stalled')) {
            diagnostic = '🔴 R2 kapena Worker sakutumiza data. Yang\'anani R2 binding ndi Worker logs.';
        } else if (msg.includes('HTTP')) {
            diagnostic = '🔴 Worker inabweletsa HTTP error. Yang\'anani <code>X-Debug-Reason</code>.';
        } else {
            diagnostic = '🔴 Onani browser console kuti muone zambiri.';
        }

        const container = document.getElementById('player-container');
        container.innerHTML = `
            <div class="error-state">
                <h2>⚠️ Playback Error</h2>
                <p style="color:#ffb3b3;font-size:0.9rem;max-width:640px;word-break:break-word;white-space:pre-wrap;">${msg.replace(/</g, '&lt;')}</p>
                <p style="color:#fff;background:#1a1a1a;padding:12px;border-radius:8px;margin-top:14px;font-size:0.9rem;">${diagnostic}</p>
                <button onclick="window.location.reload()">Retry</button>
                <button onclick="window.location.href='/'" style="background:#444;margin-top:8px;">Go Home</button>
            </div>
        `;
    }

    // ================== CLEANUP ==================
    window.addEventListener('beforeunload', () => {
        saveResumeTime(true);
        detachVideo();
        currentClientKey = null;
        if (expireTimeout) clearTimeout(expireTimeout);
        if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
    });

    init();
})();

// watch.js (Updated: secure HLS + HMAC signing, supports HLS + MP4 with auto-fallback)
(function() {
    'use strict';

    const SUPABASE_URL = window.SUPABASE_URL || 'https://jnqwvmxuieeelvukhcsq.supabase.co';
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
    const movieId = new URLSearchParams(window.location.search).get('id');

    if (!movieId) {
        showError('Missing movie ID');
        return;
    }

    // ================== 🔒 DOWNLOAD MANAGER DETECTION ==================
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

    // DOM Elements
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

    const RESUME_KEY = 'akimark_resume_' + movieId;
    const ROTATE_KEY = 'akimark_rotate_' + movieId;

    // ================== 🔒 HMAC-SHA256 (BROWSER) ==================
    async function hmacSha256Hex(secret, message) {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const sig = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(message),
        );
        return Array.from(new Uint8Array(sig))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // ================== HLS MANAGER ==================
    let hlsInstance = null;
    let currentClientKey = null;
    let currentBlobUrl = null;

    function destroyHls() {
        if (hlsInstance) {
            try { hlsInstance.destroy(); } catch {}
            hlsInstance = null;
        }
    }

    function destroyBlobUrl() {
        if (currentBlobUrl) {
            try { URL.revokeObjectURL(currentBlobUrl); } catch {}
            currentBlobUrl = null;
        }
    }

    function createSignedLoader() {
        const BaseLoader = Hls.DefaultConfig.loader;

        return class SignedLoader extends BaseLoader {
            load(context, config, callbacks) {
                const baseLoad = BaseLoader.prototype.load;
                const clientKey = currentClientKey;

                if (!clientKey) {
                    return baseLoad.call(this, context, config, callbacks);
                }

                try {
                    const u = new URL(context.url, location.origin);
                    const ts = Math.floor(Date.now() / 1000);
                    const message = `GET\n${u.pathname}\n${u.search}\n${ts}`;

                    hmacSha256Hex(clientKey, message)
                        .then((sig) => {
                            context.headers = context.headers || {};
                            context.headers['X-Client-Key'] = clientKey;
                            context.headers['X-Timestamp'] = String(ts);
                            context.headers['X-Signature'] = sig;
                            baseLoad.call(this, context, config, callbacks);
                        })
                        .catch((err) => {
                            console.error('[SignedLoader] HMAC error:', err);
                            baseLoad.call(this, context, config, callbacks);
                        });
                } catch (err) {
                    console.error('[SignedLoader] setup error:', err);
                    baseLoad.call(this, context, config, callbacks);
                }
            }
        };
    }

    function attachHls(url) {
        destroyHls();

        if (window.Hls && Hls.isSupported()) {
            const SignedLoader = createSignedLoader();

            hlsInstance = new Hls({
                enableWorker: false,
                lowLatencyMode: false,
                loader: SignedLoader,
                // Fail fast on manifest 404 (so we can fallback quickly)
                manifestLoadingTimeOut: 15000,
                manifestLoadingMaxRetry: 1,
                manifestLoadingRetryDelay: 800,
            });

            hlsInstance.loadSource(url);
            hlsInstance.attachMedia(video);

            return new Promise((resolve, reject) => {
                let settled = false;
                const settle = (fn, val) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    fn(val);
                };
                const timeout = setTimeout(
                    () => settle(reject, new Error('HLS manifest timeout (15s)')),
                    15000,
                );

                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => settle(resolve));
                hlsInstance.on(Hls.Events.ERROR, (_, data) => {
                    console.error('[HLS] Error:', data);
                    if (data.fatal) {
                        let msg = `HLS error: ${data.details} (${data.type})`;
                        if (data.response) msg += ` [HTTP ${data.response.code}]`;
                        settle(reject, new Error(msg));
                    }
                });
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            video.load();
            return Promise.resolve();
        } else {
            return Promise.reject(new Error('HLS is not supported in this browser'));
        }
    }

    // ================== 🆕 RAW VIDEO MANAGER (MP4/WebM/MKV) ==================
    async function attachRawVideo(url) {
        destroyHls();
        destroyBlobUrl();

        if (!currentClientKey) {
            video.src = url;
            video.load();
            return;
        }

        try {
            const u = new URL(url, location.origin);
            const ts = Math.floor(Date.now() / 1000);
            const message = `GET\n${u.pathname}\n${u.search}\n${ts}`;
            const sig = await hmacSha256Hex(currentClientKey, message);

            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Client-Key': currentClientKey,
                    'X-Timestamp': String(ts),
                    'X-Signature': sig,
                },
                credentials: 'omit',
            });

            if (!res.ok) {
                throw new Error(`Video fetch failed (HTTP ${res.status})`);
            }

            const blob = await res.blob();
            currentBlobUrl = URL.createObjectURL(blob);
            video.src = currentBlobUrl;
            video.load();
            return;
        } catch (err) {
            console.error('[Akimark] attachRawVideo error:', err);
            video.src = url;
            video.load();
            return;
        }
    }

    // ================== SESSION (player-session-api) ==================
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
                (data.stage ? `Stage: ${data.stage}\n` : '') +
                (data.error ? `Error: ${data.error}\n` : '') +
                (data.message ? `Message: ${data.message}\n` : '') +
                (data.missing ? `Missing: ${JSON.stringify(data.missing)}\n` : '') +
                (data.hint ? `Hint: ${data.hint}` : '')
            );
        }
        return data;
    }

    // ================== DETECT MEDIA TYPE ==================
    function isHlsSession(session) {
        if (!session) return false;

        if (typeof session.is_hls === 'boolean') return session.is_hls;

        const ct = (session.video && session.video.contentType) || '';
        if (ct.toLowerCase().includes('mpegurl')) return true;
        if (ct.toLowerCase().startsWith('video/')) return false;

        const streamUrl = String(session.streamUrl || '').toLowerCase();
        if (streamUrl.includes('.m3u8')) return true;
        if (streamUrl.includes('.mp4') || streamUrl.includes('.webm') ||
            streamUrl.includes('.mkv') || streamUrl.includes('.mov')) {
            return false;
        }

        return true;
    }

    // ================== 🔒 ANTI-DOWNLOAD HARDENING ==================
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

    // ================== 🔒 WATERMARK OVERLAY ==================
    function createWatermark() {
        let label = 'AKIMARK';
        try {
            const u = JSON.parse(localStorage.getItem('akmark_user') || '{}');
            label = u.email || u.phone || u.username || u.user_id || label;
        } catch (e) { /* ignore */ }

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

    // ================== RESUME LOGIC ==================
    function saveResumeTime(force) {
        if (isExpired) return;
        const current = video.currentTime || 0;
        const now = Date.now();
        if (force || now - lastSaveTime > 2000) {
            localStorage.setItem(RESUME_KEY, JSON.stringify({
                time: current,
                timestamp: now,
                duration: video.duration || 0
            }));
            lastSaveTime = now;
        }
    }

    function loadResumeTime() {
        const stored = localStorage.getItem(RESUME_KEY);
        if (!stored) return 0;
        try {
            const data = JSON.parse(stored);
            if (data.time && data.duration) {
                if (data.time < data.duration - 5) {
                    return data.time;
                }
            }
        } catch (e) { /* ignore */ }
        return 0;
    }

    // ================== ROTATE LOGIC ==================
    function loadRotation() {
        const rot = parseInt(localStorage.getItem(ROTATE_KEY) || '0');
        applyRotation(rot);
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

    // ================== EXPIRY OVERLAY ==================
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

    // ================== TAP ANYWHERE ==================
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

    // ================== 🆕 LOAD MEDIA WITH AUTO-FALLBACK ==================
    async function loadMedia(session) {
        const wantHls = isHlsSession(session);

        if (wantHls) {
            try {
                console.log('[Akimark] Mode: HLS');
                await attachHls(session.streamUrl);
                return;
            } catch (err) {
                console.warn('[Akimark] HLS failed, falling back to raw video:', err.message);
                destroyHls();
                // fall through to raw video
            }
        }

        console.log('[Akimark] Mode: Raw video (MP4/WebM/etc)');
        await attachRawVideo(session.streamUrl);
    }

    // ================== INITIALIZE ==================
    async function init() {
        showLoader(true);
        centerPlayBtn.classList.add('hidden');
        loadRotation();
        hardenVideoElement();
        createWatermark();

        try {
            console.log('[Akimark] Requesting session…');
            const session = await getStreamSession(movieId);
            console.log('[Akimark] Session OK. expiresIn:', session.expiresIn,
                        'isHls:', isHlsSession(session));

            currentClientKey = session.clientKey || null;
            if (!currentClientKey) throw new Error('Server did not return clientKey');

            // 🆕 Load with auto-fallback
            await loadMedia(session);

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
            console.error('[Akimark] Init error:', err);
            showError(err.message);
        }
    }

    // ================== SESSION REFRESH ==================
    let sessionRefreshTimer = null;

    function scheduleSessionRefresh(expiresIn) {
        if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
        const refreshMs = Math.max((expiresIn - 120) * 1000, 60_000);

        sessionRefreshTimer = setTimeout(async () => {
            try {
                console.log('[Akimark] Refreshing session…');
                const fresh = await getStreamSession(movieId);
                currentClientKey = fresh.clientKey;

                const wasPlaying = !video.paused;
                const curTime = video.currentTime;
                const wasMuted = video.muted;

                // 🆕 Use same auto-fallback logic on refresh
                await loadMedia(fresh);

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
            console.log('Resuming at', resumeTime);
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
    video.addEventListener('error', () => {
        showLoader(false);
        showError('Video error. Please try again.');
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
        destroyHls();
        destroyBlobUrl();
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
        const container = document.getElementById('player-container');
        if (!document.fullscreenElement) container.requestFullscreen();
        else document.exitFullscreen();
    }

    function showError(message) {
        const container = document.getElementById('player-container');
        container.innerHTML = `<div class="error-state"><h2>Error</h2><p>${message}</p><button onclick="window.location.href='/'">Go Home</button></div>`;
    }

    // ================== CLEANUP ==================
    window.addEventListener('beforeunload', () => {
        saveResumeTime(true);
        destroyHls();
        destroyBlobUrl();
        currentClientKey = null;
        if (expireTimeout) clearTimeout(expireTimeout);
        if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
    });

    init();
})();

// watch.js (Full diagnostic version — shows EXACT error)
(function() {
    'use strict';

    const SUPABASE_URL = window.SUPABASE_URL || 'https://jnqwvmxuieeelvukhcsq.supabase.co';
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || '';
    const movieId = new URLSearchParams(window.location.search).get('id');

    // ════════════════════════════════════════════════════════════
    // GLOBAL LOG BUFFER — collects every log so we can show it
    // ════════════════════════════════════════════════════════════
    const LOG_BUFFER = [];
    function log(level, ...args) {
        const line = '[' + level + '] ' + args.map(a =>
            typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
        ).join(' ');
        LOG_BUFFER.push(line);
        console.log('[' + level + ']', ...args);
    }

    function showFatal(title, message, err) {
        const container = document.getElementById('player-container') || document.body;
        const details = LOG_BUFFER.slice(-30).join('\n');
        container.innerHTML = `
            <div style="position:fixed;inset:0;background:#0b0b0f;color:#fff;padding:20px;overflow:auto;font-family:monospace;font-size:13px;line-height:1.5;">
                <h2 style="color:#ff4d4d;margin-bottom:10px;font-family:sans-serif;">${title}</h2>
                <p style="color:#ffb3b3;margin-bottom:20px;font-family:sans-serif;white-space:pre-wrap;word-break:break-word;background:#1a0a0a;padding:16px;border-radius:8px;border:1px solid #4a1515;">${message}</p>
                <details open style="background:#151515;padding:16px;border-radius:8px;border:1px solid #333;">
                    <summary style="cursor:pointer;font-weight:bold;color:#fff;margin-bottom:10px;font-family:sans-serif;">Full Log (${LOG_BUFFER.length} lines)</summary>
                    <pre style="white-space:pre-wrap;word-break:break-word;color:#8f8f8f;font-size:11px;margin:0;">${details}</pre>
                </details>
                <button onclick="location.reload()" style="margin-top:20px;padding:12px 24px;background:#E11D48;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;font-family:sans-serif;">Reload</button>
            </div>
        `;
        if (err) console.error(title, err);
    }

    log('BOOT', 'movieId=' + movieId);
    log('BOOT', 'SUPABASE_URL=' + SUPABASE_URL);
    log('BOOT', 'HAS_ANON_KEY=' + !!SUPABASE_ANON_KEY);
    log('BOOT', 'ANON_KEY_LEN=' + (SUPABASE_ANON_KEY ? SUPABASE_ANON_KEY.length : 0));
    log('BOOT', 'HLS loaded=' + !!(window.Hls));
    log('BOOT', 'UserAgent=' + navigator.userAgent);

    if (!movieId) {
        showFatal('Missing movie ID', 'URL iyenera kukhala ndi ?id=<movie_id>');
        return;
    }

    if (!SUPABASE_ANON_KEY) {
        showFatal(
            'SUPABASE_ANON_KEY missing',
            'javascript.js/supabase.js sina-load kapena sina-set SUPABASE_ANON_KEY.\n\nOnetsetsani kuti script tag ili: <script src="javascript.js/supabase.js"></script> ndipo config ili ndi window.SUPABASE_ANON_KEY = "..."'
        );
        return;
    }

    if (!window.Hls) {
        showFatal(
            'hls.js missing',
            'watch.html sina-load hls.js.\n\nOnetsetsani kuti watch.html ili ndi: <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>'
        );
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
        showFatal('Access Denied', 'Download managers are not allowed.');
        return;
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

    // ================== 🔒 HMAC-SHA256 ==================
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

    function destroyHls() {
        if (hlsInstance) {
            try { hlsInstance.destroy(); } catch {}
            hlsInstance = null;
        }
    }

    function createSignedLoader() {
        const BaseLoader = Hls.DefaultConfig.loader;

        return class SignedLoader extends BaseLoader {
            load(context, config, callbacks) {
                const baseLoad = BaseLoader.prototype.load;
                const clientKey = currentClientKey;

                log('LOADER', 'Request: ' + context.url.slice(0, 120));
                log('LOADER', 'Has key=' + !!clientKey + ' KeyPreview=' + (clientKey ? clientKey.slice(0, 16) + '...' : 'null'));

                if (!clientKey) {
                    log('LOADER', 'No clientKey — calling baseLoad directly (will fail at Worker)');
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
                            log('LOADER', 'Signed ' + u.pathname + ' ts=' + ts + ' sig=' + sig.slice(0, 16) + '...');
                            baseLoad.call(this, context, config, callbacks);
                        })
                        .catch((err) => {
                            log('LOADER', 'HMAC error: ' + err.message);
                            baseLoad.call(this, context, config, callbacks);
                        });
                } catch (err) {
                    log('LOADER', 'Setup error: ' + err.message);
                    baseLoad.call(this, context, config, callbacks);
                }
            }
        };
    }

    function attachHls(url) {
        destroyHls();

        log('HLS', 'Attaching URL: ' + url.slice(0, 150));

        if (window.Hls && Hls.isSupported()) {
            const SignedLoader = createSignedLoader();

            hlsInstance = new Hls({
                enableWorker: false,
                lowLatencyMode: false,
                loader: SignedLoader,
                debug: false,
                manifestLoadingTimeOut: 20000,
                manifestLoadingMaxRetry: 2,
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
                const timeout = setTimeout(() => {
                    settle(reject, new Error(
                        'HLS manifest timeout (30s)\n\n' +
                        'Check these:\n' +
                        '1. Cloudflare Worker is deployed and reachable\n' +
                        '2. Worker route: akimark.mw/api/player-api/*\n' +
                        '3. Supabase player-session-api returns valid streamUrl'
                    ));
                }, 30000);

                hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
                    log('HLS', '✅ Manifest parsed successfully');
                    settle(resolve);
                });

                hlsInstance.on(Hls.Events.ERROR, (_, data) => {
                    log('HLS', 'ERROR event: ' + JSON.stringify({
                        type: data.type,
                        details: data.details,
                        fatal: data.fatal,
                        reason: data.reason,
                        response: data.response ? {
                            code: data.response.code,
                            text: data.response.text ? data.response.text.slice(0, 200) : null,
                            url: data.response.url,
                        } : null,
                        url: data.url,
                    }));

                    if (data.fatal) {
                        let msg = 'HLS FATAL ERROR\n\n';
                        msg += 'Type: ' + data.type + '\n';
                        msg += 'Details: ' + data.details + '\n';
                        if (data.reason) msg += 'Reason: ' + data.reason + '\n';
                        if (data.response) {
                            msg += 'HTTP Code: ' + data.response.code + '\n';
                            msg += 'URL: ' + (data.response.url || data.url || '') + '\n';
                            if (data.response.text) {
                                msg += 'Response Body:\n' + data.response.text.slice(0, 500);
                            }
                        }
                        msg += '\n\nCheck console logs for full details.';
                        settle(reject, new Error(msg));
                    }
                });
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            log('HLS', 'Native Safari HLS');
            video.src = url;
            video.load();
            return Promise.resolve();
        } else {
            return Promise.reject(new Error('HLS is not supported in this browser'));
        }
    }

    // ================== SESSION (player-session-api) ==================
    const userToken = localStorage.getItem('akmark_token');

    async function getStreamSession(videoId) {
        log('SESSION', 'POST player-session-api for video_id=' + videoId);
        log('SESSION', 'UserToken present=' + !!userToken);

        const reqHeaders = {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            ...(userToken ? { 'X-User-Token': userToken } : {}),
        };

        const res = await fetch(
            `${SUPABASE_URL}/functions/v1/player-session-api`,
            {
                method: 'POST',
                headers: reqHeaders,
                body: JSON.stringify({ video_id: videoId }),
            }
        );

        log('SESSION', 'HTTP status=' + res.status + ' ok=' + res.ok);

        const text = await res.text();
        log('SESSION', 'Raw response: ' + text.slice(0, 500));

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            data = { error: 'Non-JSON response', raw: text.slice(0, 300) };
        }

        if (!res.ok) {
            let msg = 'SESSION API ERROR (HTTP ' + res.status + ')\n\n';
            if (data.stage) msg += 'Stage: ' + data.stage + '\n';
            if (data.error) msg += 'Error: ' + data.error + '\n';
            if (data.message) msg += 'Message: ' + data.message + '\n';
            if (data.missing) msg += 'Missing: ' + JSON.stringify(data.missing) + '\n';
            if (data.hint) msg += 'Hint: ' + data.hint + '\n';
            msg += '\nRaw body:\n' + text.slice(0, 500);
            throw new Error(msg);
        }

        return data;
    }

    // ================== 🔒 ANTI-DOWNLOAD ==================
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

    // ================== 🔒 WATERMARK ==================
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
        log('EXPIRE', 'Session expired');
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
        log('INIT', 'Starting...');
        showLoader(true);
        centerPlayBtn.classList.add('hidden');
        loadRotation();
        hardenVideoElement();
        createWatermark();

        try {
            log('INIT', 'Step 1/3: requesting session');
            const session = await getStreamSession(movieId);

            log('INIT', 'Session response fields: ' + JSON.stringify({
                success: session.success,
                hasStreamUrl: !!session.streamUrl,
                hasClientKey: !!session.clientKey,
                expiresIn: session.expiresIn,
                streamUrlPreview: session.streamUrl ? session.streamUrl.slice(0, 100) : null,
            }));

            currentClientKey = session.clientKey || null;

            if (!currentClientKey) {
                throw new Error(
                    'MISSING clientKey\n\n' +
                    'player-session-api sina-return clientKey.\n\n' +
                    'Zoyenera kuchita:\n' +
                    '1. Re-deploy player-session-api ndi code yatsopano\n' +
                    '2. Onetsetsani kuti response ili ndi field ya clientKey'
                );
            }

            if (!session.streamUrl) {
                throw new Error(
                    'MISSING streamUrl\n\n' +
                    'player-session-api sina-return streamUrl.'
                );
            }

            log('INIT', 'Step 2/3: attaching HLS');
            await attachHls(session.streamUrl);
            log('INIT', 'HLS attached OK');

            if (session.expiresIn) {
                expireTime = Date.now() + (session.expiresIn * 1000);
                const remaining = expireTime - Date.now();
                if (remaining <= 0) onExpire();
                else expireTimeout = setTimeout(onExpire, remaining);
                log('INIT', 'Expires in ' + session.expiresIn + 's');
            }

            log('INIT', 'Step 3/3: play');
            video.play().catch((e) => {
                log('INIT', 'Autoplay blocked: ' + e.message);
                if (!isExpired) centerPlayBtn.classList.remove('hidden');
            });
            showControls();
            log('INIT', '✅ DONE');

        } catch (err) {
            log('INIT', 'FATAL: ' + (err.message || err));
            showFatal('Playback Failed', err.message || String(err), err);
        }
    }

    // ================== VIDEO EVENTS ==================
    video.addEventListener('loadedmetadata', () => {
        log('VIDEO', 'Metadata loaded. duration=' + video.duration);
        durationTimeEl.textContent = formatTime(video.duration);
        const resumeTime = loadResumeTime();
        if (resumeTime > 0 && resumeTime < video.duration - 5) {
            video.currentTime = resumeTime;
            log('VIDEO', 'Resumed at ' + resumeTime);
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
        const err = video.error;
        let msg = 'VIDEO ELEMENT ERROR\n\n';
        if (err) {
            const codeMap = {
                1: 'MEDIA_ERR_ABORTED',
                2: 'MEDIA_ERR_NETWORK',
                3: 'MEDIA_ERR_DECODE',
                4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
            };
            msg += 'Code: ' + (codeMap[err.code] || err.code) + '\n';
            if (err.message) msg += 'Message: ' + err.message + '\n';
        }
        msg += '\nFull logs below.';
        log('VIDEO', 'error: ' + JSON.stringify({
            code: err ? err.code : null,
            message: err ? err.message : null,
        }));
        showLoader(false);
        showFatal('Video Element Error', msg, err);
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

    // ================== CLEANUP ==================
    window.addEventListener('beforeunload', () => {
        saveResumeTime(true);
        destroyHls();
        currentClientKey = null;
        if (expireTimeout) clearTimeout(expireTimeout);
    });

    init();
})();

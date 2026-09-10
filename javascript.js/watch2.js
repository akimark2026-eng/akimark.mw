// watch.js (Updated with Resume, Watermark, Exit, Rotate)
(function() {
    'use strict';

    const SUPABASE_URL = window.SUPABASE_URL || 'https://jnqwvmxuieeelvukhcsq.supabase.co';
    const movieId = new URLSearchParams(window.location.search).get('id');

    if (!movieId) {
        showError('Missing movie ID');
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
    let lastSaveTime = 0; // For resume saving

    // Resume storage keys
    const RESUME_KEY = 'akimark_resume_' + movieId;
    const ROTATE_KEY = 'akimark_rotate_' + movieId;

    // ===== RESUME LOGIC =====
    function saveResumeTime(force) {
        if (isExpired) return;
        const current = video.currentTime || 0;
        const now = Date.now();
        if (force || now - lastSaveTime > 2000) { // save every 2 seconds
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
                // If saved time is less than duration - 5 seconds, resume
                if (data.time < data.duration - 5) {
                    return data.time;
                }
            }
        } catch(e) { /* ignore */ }
        return 0;
    }

    // ===== ROTATE LOGIC =====
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

    // ===== CREATE EXPIRY OVERLAY =====
    function createExpiryOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'expiryOverlay';
        overlay.style.cssText = `
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.85);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            z-index: 20;
            text-align: center;
            padding: 20px;
            color: #fff;
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

    // ===== ON EXPIRE =====
    function onExpire() {
        isExpired = true;
        video.pause();
        playPauseBtn.querySelector('#playIcon').style.display = 'block';
        playPauseBtn.querySelector('#pauseIcon').style.display = 'none';
        centerPlayBtn.classList.add('hidden');
        controls.style.pointerEvents = 'none';
        // Clear resume
        localStorage.removeItem(RESUME_KEY);
        // Show overlay
        let overlay = document.getElementById('expiryOverlay');
        if (!overlay) overlay = createExpiryOverlay();
        overlay.style.display = 'flex';
    }

    // ===== SCRUBBER =====
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

    progressBar.addEventListener('pointerup', (e) => {
        isSeeking = false;
        showControls();
    });

    function updateSeek(e) {
        const rect = progressBar.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percent = Math.min(1, Math.max(0, x / rect.width));
        if (video.duration) {
            video.currentTime = percent * video.duration;
        }
        progressFill.style.width = `${percent * 100}%`;
        progressThumb.style.left = `${percent * 100}%`;
        currentTimeEl.textContent = formatTime(video.currentTime);
    }

    // ===== TAP ANYWHERE ON SCREEN =====
    let tapStartX = 0;
    let tapStartY = 0;
    let tapStartTime = 0;

    playerContainer.addEventListener('pointerdown', (e) => {
        if (isExpired) return;
        if (e.target.closest('.controls') || e.target.closest('#centerPlayBtn') || e.target.closest('#exitBtn') || e.target.closest('#rotateBtn')) return;
        tapStartX = e.clientX;
        tapStartY = e.clientY;
        tapStartTime = Date.now();
    });

    playerContainer.addEventListener('pointerup', (e) => {
        if (isExpired) return;
        if (e.target.closest('.controls') || e.target.closest('#centerPlayBtn') || e.target.closest('#exitBtn') || e.target.closest('#rotateBtn')) return;
        const dx = e.clientX - tapStartX;
        const dy = e.clientY - tapStartY;
        const dt = Date.now() - tapStartTime;
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 500) {
            if (controls.classList.contains('visible')) {
                controls.classList.remove('visible');
            } else {
                showControls();
            }
        }
    });

    // ===== INITIALIZE =====
    async function init() {
        showLoader(true);
        centerPlayBtn.classList.add('hidden');
        loadRotation(); // Apply saved rotation
        try {
            const res = await fetch(`${SUPABASE_URL}/functions/v1/viewing-film-api?action=get_watch_info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ movie_id: movieId })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to load');

            video.src = data.video_url;
            video.poster = data.movie.poster_url || '';
            video.load();

            // Set expiry
            if (data.expires_in) {
                expireTime = Date.now() + (data.expires_in * 1000);
            } else if (data.expire_at) {
                expireTime = new Date(data.expire_at).getTime();
            }
            if (expireTime) {
                const remaining = expireTime - Date.now();
                if (remaining <= 0) {
                    onExpire();
                } else {
                    expireTimeout = setTimeout(onExpire, remaining);
                }
            }

            // Auto-play
            video.play().catch(() => {
                if (!isExpired) centerPlayBtn.classList.remove('hidden');
            });

            showControls();
        } catch (err) {
            showError(err.message);
        }
    }

    // ===== VIDEO EVENTS =====
    video.addEventListener('loadedmetadata', () => {
        durationTimeEl.textContent = formatTime(video.duration);
        // Resume position
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
        // Save resume periodically
        saveResumeTime(false);
        if (expireTime && Date.now() > expireTime) {
            onExpire();
        }
    });

    video.addEventListener('play', () => {
        if (isExpired) {
            video.pause();
            return;
        }
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

    // ===== CONTROLS =====
    playPauseBtn.addEventListener('click', () => {
        if (isExpired) return;
        if (video.paused) video.play();
        else video.pause();
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

    // ===== EXIT BUTTON =====
    exitBtn.addEventListener('click', () => {
        // Save current position before exit
        saveResumeTime(true);
        window.location.href = 'my-movies.html';
    });

    // ===== ROTATE BUTTON =====
    rotateBtn.addEventListener('click', () => {
        if (isExpired) return;
        rotate();
        showControls();
    });

    // ===== AUTO-HIDE CONTROLS =====
    function showControls() {
        if (isExpired) return;
        controls.classList.add('visible');
        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(() => {
            if (!video.paused && !isSeeking && !isExpired) {
                controls.classList.remove('visible');
            }
        }, 3000);
    }

    // Hide speed menu on outside click
    document.addEventListener('click', (e) => {
        if (!speedOptions.contains(e.target) && e.target !== speedBtn) {
            speedOptions.classList.remove('show');
        }
    });

    // ===== HELPERS =====
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

    function showLoader(show) {
        loader.style.display = show ? 'block' : 'none';
    }

    function toggleFullscreen() {
        const container = document.getElementById('player-container');
        if (!document.fullscreenElement) {
            container.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    }

    function showError(message) {
        const container = document.getElementById('player-container');
        container.innerHTML = `<div class="error-state"><h2>Error</h2><p>${message}</p><button onclick="window.location.href='/'">Go Home</button></div>`;
    }

    // ===== CLEANUP =====
    window.addEventListener('beforeunload', () => {
        saveResumeTime(true);
        if (expireTimeout) clearTimeout(expireTimeout);
    });

    // ===== START =====
    init();
})();

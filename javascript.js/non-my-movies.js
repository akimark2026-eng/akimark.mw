// non-my-movies.js (Updated: active films go to watch.html)

(function() {
    'use strict';

    const SUPABASE_URL = window.SUPABASE_URL;
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // DOM Elements
    const skeleton = document.getElementById('skeleton');
    const movieList = document.getElementById('movieList');
    const emptyState = document.getElementById('emptyState');
    const toast = document.getElementById('toast');

    // ===== ENSURE ANONYMOUS SESSION =====
    async function ensureSession() {
        let { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            await supabase.auth.signInAnonymously();
            session = (await supabase.auth.getSession()).data.session;
        }
        return session;
    }

    // ===== FORMAT TIME =====
    function formatTimeLeft(seconds) {
        if (seconds <= 0) return 'Expired';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}h ${m}m ${s}s`;
        return `${m}m ${s}s`;
    }

    function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
    }

    // ===== LOAD MY VIEWS =====
    async function loadMyMovies() {
        try {
            const session = await ensureSession();
            const token = session.access_token;

            const res = await fetch(`${SUPABASE_URL}/functions/v1/non-get-my-movies-api`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load');

            // Hide skeleton
            skeleton.style.display = 'none';

            if (!data.views || data.views.length === 0) {
                movieList.style.display = 'none';
                emptyState.style.display = 'flex';
                return;
            }

            emptyState.style.display = 'none';
            movieList.style.display = 'flex';
            renderMovies(data.views);
        } catch (err) {
            console.error('Error loading my movies:', err);
            skeleton.style.display = 'none';
            movieList.style.display = 'none';
            emptyState.style.display = 'flex';
            showToast('Failed to load movies');
        }
    }

    // ===== RENDER MOVIES =====
    function renderMovies(views) {
        movieList.innerHTML = '';

        views.forEach(view => {
            const expireAt = new Date(view.expire_at).getTime();
            const now = Date.now();
            const timeLeft = Math.floor((expireAt - now) / 1000);
            const isExpired = timeLeft <= 0;

            const item = document.createElement('div');
            item.className = 'movie-item';

            // UPDATED: Active films go to watch.html, expired remain disabled
            const watchLink = isExpired
                ? `<a href="watch.html?id=${view.movie_id}" class="watch-btn disabled">EXPIRED</a>`
                : `<a href="watch.html?id=${view.movie_id}" class="watch-btn">WATCH NOW</a>`;

            item.innerHTML = `
                <div class="poster-wrap">
                    <img src="${view.movie.poster_url || ''}" alt="${view.movie.title || 'Movie'}">
                </div>
                <div class="info">
                    <div class="title">${view.movie.title || 'Unknown Title'}</div>
                    <div class="meta">${view.movie.quality || 'HD'} • Paid: MK ${Number(view.price_paid || 0).toLocaleString()}</div>
                    <div class="expiry">${isExpired ? 'Expired' : 'Expires in ' + formatTimeLeft(timeLeft)}</div>
                    ${watchLink}
                </div>
            `;

            movieList.appendChild(item);
        });
    }

    // ===== START COUNTDOWN UPDATES =====
    setInterval(() => {
        if (movieList.style.display === 'none') return;
        const items = movieList.querySelectorAll('.movie-item');
        items.forEach(item => {
            const expiryEl = item.querySelector('.expiry');
            const watchBtn = item.querySelector('.watch-btn');
            if (!expiryEl) return;

            // We'll need a data attribute to store the expire_at
            // But for simplicity, we reload on interval if needed
        });
    }, 1000);

    // Initialize
    loadMyMovies();
})();

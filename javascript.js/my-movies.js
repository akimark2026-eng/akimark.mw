// my-movies.js
(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
        window.location.href = 'login.html';
        return;
    }

    var SUPABASE_URL = window.SUPABASE_URL;
    var movieListEl = document.getElementById('movieList');
    var emptyStateEl = document.getElementById('emptyState');
    var summaryBar = document.getElementById('summaryBar');
    var toast = document.getElementById('toast');
    var skeletonEl = document.getElementById('skeleton');

    // ===== SHOW SKELETON =====
    function showSkeleton() {
        if (skeletonEl) skeletonEl.style.display = 'block';
        if (movieListEl) movieListEl.style.display = 'none';
        if (emptyStateEl) emptyStateEl.style.display = 'none';
    }

    // ===== HIDE SKELETON =====
    function hideSkeleton() {
        if (skeletonEl) skeletonEl.style.display = 'none';
    }

    // ===== FETCH MY MOVIES =====
    async function loadMyMovies() {
        showSkeleton();
        try {
            var res = await fetch(`${SUPABASE_URL}/functions/v1/my-film-api`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load');

            hideSkeleton();

            if (!data.films || data.films.length === 0) {
                movieListEl.innerHTML = '';
                emptyStateEl.style.display = 'flex';
                movieListEl.style.display = 'none'; // Bisa list
                if (summaryBar) summaryBar.innerHTML = '<span>0 VIDEOS</span><span>0.0 GB</span>';
                return;
            }
            
            emptyStateEl.style.display = 'none';
            movieListEl.style.display = 'flex'; // ONANI: IZI NDI ZOFUNIKA KUTI ZIWONEKE
            movieListEl.style.flexDirection = 'column';
            renderList(data.films);
            updateSummary(data.films);
        } catch (err) {
            console.error('Error:', err);
            hideSkeleton();
            movieListEl.innerHTML = '';
            movieListEl.style.display = 'none';
            emptyStateEl.style.display = 'flex';
            showToast('Failed to load your movies');
        }
    }

    // ===== GET FILM DATA (Flattened or Nested) =====
    function getFilmData(film) {
        // Ngati backend imabweza flattened (film.title, film.poster_url)
        if (film.title && film.poster_url) {
            return film;
        }
        // Ngati backend imabweza nested (film.movies.title, film.movies.poster_url)
        if (film.movies && film.movies.title) {
            return {
                id: film.id,
                title: film.movies.title,
                poster_url: film.movies.poster_url,
                quality: film.movies.quality || 'HD',
                price_paid: film.price_paid || 0,
                expire_at: film.expire_at,
                time_left_seconds: film.time_left_seconds || 0
            };
        }
        // Fallback
        return {
            id: film.id,
            title: film.movies?.title || 'Unknown Title',
            poster_url: film.movies?.poster_url || '',
            quality: film.movies?.quality || 'HD',
            price_paid: film.price_paid || 0,
            expire_at: film.expire_at,
            time_left_seconds: film.time_left_seconds || 0
        };
    }

    // ===== UPDATE SUMMARY =====
    function updateSummary(films) {
        var count = films.length;
        var totalSizeGB = (count * 0.2).toFixed(1);
        if (summaryBar) summaryBar.innerHTML = '<span>' + count + ' VIDEOS</span><span>' + totalSizeGB + ' GB</span>';
    }

    // ===== RENDER MOVIE LIST =====
    function renderList(films) {
        movieListEl.innerHTML = '';
        films.forEach(function(rawFilm) {
            var film = getFilmData(rawFilm); // Gwiritsani ntchito helper
            var item = document.createElement('div');
            item.className = 'movie-item';
            item.dataset.id = film.id;
            item.dataset.expireAt = film.expire_at;

            var timeLeft = film.time_left_seconds || 0;
            var isExpired = timeLeft <= 0;
            var totalSeconds = 600;
            var progressPercent = Math.min(100, Math.max(0, (timeLeft / totalSeconds) * 100));
            var timeLeftStr = formatTimeLeft(timeLeft);

            var watchClass = isExpired ? 'watch-btn disabled' : 'watch-btn';
            var watchText = isExpired ? 'Expired' : 'WATCH NOW';

            item.innerHTML = `
                <div class="poster-wrap">
                    <img src="${film.poster_url || ''}" alt="${film.title || 'Movie'}" loading="lazy">
                </div>
                <div class="info">
                    <div class="title">${film.title || 'Unknown Title'}</div>
                    <div class="meta">${film.quality || 'HD'} • Paid: MK ${Number(film.price_paid || 0).toLocaleString()}</div>
                    <div class="expiry">${isExpired ? 'Expired' : 'Expires in ' + timeLeftStr}</div>
                    <a href="watch.html?id=${film.id}" class="${watchClass}" onclick="return handleWatchClick(event, this)">${watchText}</a>
                </div>
            `;
            movieListEl.appendChild(item);
        });

        startCountdowns();
    }

    // ===== FORMAT TIME =====
    function formatTimeLeft(seconds) {
        if (seconds <= 0) return '00:00';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = seconds % 60;
        if (h > 0) return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
        return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    }

    // ===== COUNTDOWN UPDATER =====
    function startCountdowns() {
        if (window._countdownInterval) clearInterval(window._countdownInterval);
        window._countdownInterval = setInterval(function() {
            var items = document.querySelectorAll('.movie-item');
            items.forEach(function(item) {
                var expireAt = new Date(item.dataset.expireAt).getTime();
                var now = Date.now();
                var diff = Math.floor((expireAt - now) / 1000);
                var expiryEl = item.querySelector('.expiry');
                var watchLink = item.querySelector('.watch-btn');
                if (!expiryEl) return;

                if (diff <= 0) {
                    expiryEl.textContent = 'Expired';
                    watchLink.classList.add('disabled');
                    watchLink.textContent = 'Expired';
                } else {
                    expiryEl.textContent = 'Expires in ' + formatTimeLeft(diff);
                }
            });
        }, 1000);
    }

    // ===== HANDLE WATCH CLICK =====
    window.handleWatchClick = function(event, el) {
        if (el.classList.contains('disabled')) {
            event.preventDefault();
            showToast('This movie has expired. Please purchase again.');
            return false;
        }
        return true;
    };

    // ===== SHOW TOAST =====
    function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 3000);
    }

    // ===== INIT =====
    loadMyMovies();
})();

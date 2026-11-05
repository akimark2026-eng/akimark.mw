// my-movies.js (v3 — Pro High-End with Episode Numbers, Optimized Rendering & Bulletproof Auth)
// Fixes auto-logout in WebView by using Cookie fallback and smart error handling.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    // ════════════════════════════════════════════════════════════
    // 🎯 COOKIE HELPERS (Fallback for WebView LocalStorage issues)
    // ════════════════════════════════════════════════════════════
    function setCookie(name, value, days) {
        var expires = "";
        if (days) {
            var date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            expires = "; expires=" + date.toUTCString();
        }
        document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax";
    }
    
    function getCookie(name) {
        var nameEQ = name + "=";
        var ca = document.cookie.split(';');
        for(var i=0; i < ca.length; i++) {
            var c = ca[i];
            while (c.charAt(0)==' ') c = c.substring(1,c.length);
            if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
        }
        return null;
    }
    
    function eraseCookie(name) {   
        document.cookie = name +'=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 ROBUST TOKEN RETRIEVAL
    // ════════════════════════════════════════════════════════════
    function getToken() {
        var token = localStorage.getItem(TOKEN_KEY);
        if (!token) token = sessionStorage.getItem(TOKEN_KEY);
        if (!token) token = getCookie(TOKEN_KEY); // Check Cookie Fallback
        
        if (!token || token === 'null' || token === 'undefined') return null;
        
        try {
            var parsed = JSON.parse(token);
            if (parsed && parsed.access_token) return parsed.access_token;
            if (typeof parsed === 'string') return parsed;
        } catch(e) {}
        
        return String(token).replace(/^["']|["']$/g, '').trim();
    }

    function setTokenInAllPlaces(token) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(TOKEN_KEY, token);
        setCookie(TOKEN_KEY, token, 7); 
    }

    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        sessionStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem(USER_KEY);
        eraseCookie(TOKEN_KEY);
        eraseCookie('akmark_user_logged');
    }

    // ════════════════════════════════════════════════════════════
    // INITIAL TOKEN CHECK
    // ════════════════════════════════════════════════════════════
    var token = getToken();
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    setTokenInAllPlaces(token); // Ensure it's in Cookie

    var SUPABASE_URL = window.SUPABASE_URL;
    var movieListEl = document.getElementById('movieList');
    var emptyStateEl = document.getElementById('emptyState');
    var summaryBar = document.getElementById('summaryBar');
    var toast = document.getElementById('toast');
    var skeletonEl = document.getElementById('skeleton');

    // ===== UTILS =====
    // Pro Architecture: XSS Protection
    function escapeHTML(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

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

            // 🎯 CRITICAL FIX: Only logout if server explicitly says Unauthorized/Forbidden
            if (res.status === 401 || res.status === 403) {
                console.warn('Session invalid. Logging out.');
                clearSession();
                window.location.href = 'login.html';
                return;
            }

            var data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load');

            hideSkeleton();

            if (!data.films || data.films.length === 0) {
                movieListEl.innerHTML = '';
                emptyStateEl.style.display = 'flex';
                movieListEl.style.display = 'none';
                if (summaryBar) summaryBar.innerHTML = '<span>0 VIDEOS</span><span></span>';
                return;
            }
            
            emptyStateEl.style.display = 'none';
            movieListEl.style.display = 'flex'; 
            movieListEl.style.flexDirection = 'column';
            renderList(data.films);
            updateSummary(data.films);
        } catch (err) {
            console.error('Error:', err);
            hideSkeleton();
            
            // 🎯 CRITICAL FIX: If WebView drops network during navigation, don't show empty state, just show a toast.
            if (movieListEl.innerHTML === '') {
                movieListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: #aaa;">Network error. Please pull to refresh.</div>';
            }
            showToast('Network error. Check connection.');
        }
    }

    // ===== GET FILM DATA (Flattened or Nested) =====
    function getFilmData(film) {
        if (film.title && film.poster_url) {
            return {
                id: film.id,
                title: film.title,
                poster_url: film.poster_url,
                quality: film.quality || 'HD',
                price_paid: film.price_paid || 0,
                expire_at: film.expire_at,
                time_left_seconds: film.time_left_seconds || 0,
                episode_number: film.episode_number || null
            };
        }
        if (film.movies && film.movies.title) {
            return {
                id: film.id,
                title: film.movies.title,
                poster_url: film.movies.poster_url,
                quality: film.movies.quality || 'HD',
                price_paid: film.price_paid || 0,
                expire_at: film.expire_at,
                time_left_seconds: film.time_left_seconds || 0,
                episode_number: film.movies.episode_number || null
            };
        }
        return {
            id: film.id,
            title: film.movies?.title || 'Unknown Title',
            poster_url: film.movies?.poster_url || '',
            quality: film.movies?.quality || 'HD',
            price_paid: film.price_paid || 0,
            expire_at: film.expire_at,
            time_left_seconds: film.time_left_seconds || 0,
            episode_number: film.episode_number || film.movies?.episode_number || null
        };
    }

    // ===== UPDATE SUMMARY =====
    function updateSummary(films) {
        var count = films.length;
        var totalSizeGB = (count * 0.2).toFixed(1);
        if (summaryBar) summaryBar.innerHTML = '<span>' + count + ' VIDEOS</span><span>' + totalSizeGB + ' GB</span>';
    }

    // ===== RENDER MOVIE LIST (Pro High-End & Optimized) =====
    function renderList(films) {
        var html = ''; 

        films.forEach(function(rawFilm) {
            var film = getFilmData(rawFilm);
            var timeLeft = film.time_left_seconds || 0;
            var isExpired = timeLeft <= 0;
            
            var watchClass = isExpired ? 'watch-btn disabled' : 'watch-btn';
            var watchText = isExpired ? 'Expired' : 'WATCH NOW';

            var epBadge = '';
            if (film.episode_number) {
                epBadge = `<span style="display:inline-block; font-size:10px; font-weight:800; background:#FFD700; color:#000; padding:2px 6px; border-radius:4px; margin-left:6px; vertical-align:middle; transform:translateY(-2px);">EP ${film.episode_number}</span>`;
            }

            html += `
                <div class="movie-item" data-id="${film.id}" data-expire-at="${film.expire_at}">
                    <div class="poster-wrap">
                        <img src="${escapeHTML(film.poster_url)}" alt="${escapeHTML(film.title)}" loading="lazy">
                    </div>
                    <div class="info">
                        <div class="title">
                            ${escapeHTML(film.title || 'Unknown Title')} ${epBadge}
                        </div>
                        <div class="meta">${escapeHTML(film.quality)} • Paid: MK ${Number(film.price_paid || 0).toLocaleString()}</div>
                        <div class="expiry">${isExpired ? 'Expired' : 'Expires in ' + formatTimeLeft(timeLeft)}</div>
                        <a href="watch.html?id=${film.id}" class="${watchClass}" onclick="return handleWatchClick(event, this)">${watchText}</a>
                    </div>
                </div>
            `;
        });

        movieListEl.innerHTML = html;
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
                    if (watchLink) {
                        watchLink.classList.add('disabled');
                        watchLink.textContent = 'Expired';
                    }
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
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 3000);
    }

    // ===== INIT =====
    loadMyMovies();
})();

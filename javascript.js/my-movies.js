// my-movies.js (v4 — Pro Cache-First + Zero-Block + SWR + Countdown Accuracy)
// Upgrades vs v3:
//  - my-film-api cached 3min in sessionStorage (per-token).
//  - Zero-block: cached list rendered immediately (0ms).
//  - SWR: 1-3min cache shows instantly + revalidates in background.
//  - Countdown accuracy: time_left computed from expire_at (absolute), not stale API field.
//  - Global 401 handler, dedupeFetch, visibility refresh.
//  - Optimized countdown: querySelector once per render, not per second.
//  - Safe storage helpers, DOMContentLoaded guard.
//  - Public window.MyMoviesRefresh() for manual refresh.
//  - Cache key matches AkimarkCache.clearAll() (home.js) for clean logout.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    // ════════════════════════════════════════════════════════════
    // 🎯 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_PREFIX = 'akmark_cache_mymovies_'; // per-token
    var TTL = {
        MYFILMS: 3 * 60 * 1000  // 3 min
    };
    var SWR_THRESHOLD = 60 * 1000; // 1 min — revalidate in background after 1 min

    // ════════════════════════════════════════════════════════════
    // 🎯 COOKIE HELPERS
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
        for (var i = 0; i < ca.length; i++) {
            var c = ca[i];
            while (c.charAt(0) == ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
        }
        return null;
    }
    function eraseCookie(name) {
        document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 SAFE STORAGE
    // ════════════════════════════════════════════════════════════
    function safeGet(storage, key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function safeSet(storage, key, val) { try { storage.setItem(key, val); } catch (e) {} }
    function safeRemove(storage, key) { try { storage.removeItem(key); } catch (e) {} }

    // ════════════════════════════════════════════════════════════
    // 🎯 CACHE HELPERS
    // ════════════════════════════════════════════════════════════
    function cacheRead(key) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try {
            var parsed = JSON.parse(raw);
            return { data: parsed.data, age: Date.now() - parsed.ts, ts: parsed.ts };
        } catch (e) { return null; }
    }
    function cacheWrite(key, data) {
        safeSet(sessionStorage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TOKEN / SESSION
    // ════════════════════════════════════════════════════════════
    function getToken() {
        var token = safeGet(localStorage, TOKEN_KEY);
        if (!token) token = safeGet(sessionStorage, TOKEN_KEY);
        if (!token) token = getCookie(TOKEN_KEY);
        if (!token || token === 'null' || token === 'undefined') return null;
        try {
            var parsed = JSON.parse(token);
            if (parsed && parsed.access_token) return parsed.access_token;
            if (typeof parsed === 'string') return parsed;
        } catch (e) {}
        return String(token).replace(/^["']|["']$/g, '').trim();
    }

    function setTokenInAllPlaces(token) {
        safeSet(localStorage, TOKEN_KEY, token);
        safeSet(sessionStorage, TOKEN_KEY, token);
        setCookie(TOKEN_KEY, token, 7);
    }

    function clearSession() {
        var token = window._currentToken || getToken();

        safeRemove(localStorage, TOKEN_KEY);
        safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token');
        safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY);
        eraseCookie(TOKEN_KEY);
        eraseCookie('akmark_user_logged');

        if (token) {
            safeRemove(sessionStorage, CACHE_PREFIX + token);
        }
    }

    function handleAuthError(status) {
        if (status === 401 || status === 403) {
            clearSession();
            window.location.href = 'login.html';
            return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 INITIAL TOKEN CHECK (LOCAL ONLY, NO NETWORK)
    // ════════════════════════════════════════════════════════════
    var token = getToken();
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    window._currentToken = token;
    setTokenInAllPlaces(token);

    // ════════════════════════════════════════════════════════════
    // 🎯 DEDUPE FETCH
    // ════════════════════════════════════════════════════════════
    var inflight = {};
    function dedupeFetch(url, options) {
        var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : '');
        if (inflight[key]) return inflight[key];
        var p = fetch(url, options).finally(function() { delete inflight[key]; });
        inflight[key] = p;
        return p;
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 UTILS
    // ════════════════════════════════════════════════════════════
    function escapeHTML(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    function formatTimeLeft(seconds) {
        if (seconds <= 0) return '00:00';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = seconds % 60;
        if (h > 0) {
            return (h < 10 ? '0' + h : h) + ':' +
                   (m < 10 ? '0' + m : m) + ':' +
                   (s < 10 ? '0' + s : s);
        }
        return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 DOM READY
    // ════════════════════════════════════════════════════════════
    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    onReady(function() {
        var SUPABASE_URL = window.SUPABASE_URL;
        var movieListEl = document.getElementById('movieList');
        var emptyStateEl = document.getElementById('emptyState');
        var summaryBar = document.getElementById('summaryBar');
        var toast = document.getElementById('toast');
        var skeletonEl = document.getElementById('skeleton');

        var cacheKey = CACHE_PREFIX + token;
        var countdownInterval = null;
        var appInited = false;

        // ════════════════════════════════════════════════════════
        // 🎯 SKELETON
        // ════════════════════════════════════════════════════════
        function showSkeleton() {
            if (skeletonEl) skeletonEl.style.display = 'block';
            if (movieListEl) movieListEl.style.display = 'none';
            if (emptyStateEl) emptyStateEl.style.display = 'none';
        }
        function hideSkeleton() {
            if (skeletonEl) skeletonEl.style.display = 'none';
        }

        // ════════════════════════════════════════════════════════
        // 🎯 FETCH MY MOVIES (returns Promise<films|null>)
        // ════════════════════════════════════════════════════════
        function fetchMyMovies() {
            return dedupeFetch(SUPABASE_URL + '/functions/v1/my-film-api', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            })
            .then(function(res) {
                if (handleAuthError(res.status)) return null;
                if (!res.ok) throw new Error('Failed to load');
                return res.json();
            })
            .then(function(data) {
                if (!data) return null;
                var films = data.films || [];
                cacheWrite(cacheKey, films);
                return films;
            });
        }

        // ════════════════════════════════════════════════════════
        // 🎯 GET FILM DATA — compute accurate time_left from expire_at
        // ════════════════════════════════════════════════════════
        function getFilmData(film) {
            var base;
            if (film.title && film.poster_url) {
                base = film;
            } else if (film.movies && film.movies.title) {
                base = film.movies;
            } else {
                base = film.movies || {};
            }

            var expireAt = film.expire_at || base.expire_at;
            var timeLeft;
            if (expireAt) {
                // Compute from absolute time — accurate even with stale cache.
                timeLeft = Math.max(0, Math.floor((new Date(expireAt).getTime() - Date.now()) / 1000));
            } else {
                timeLeft = film.time_left_seconds || base.time_left_seconds || 0;
            }

            return {
                id: film.id,
                title: base.title || 'Unknown Title',
                poster_url: base.poster_url || '',
                quality: base.quality || 'HD',
                price_paid: film.price_paid || 0,
                expire_at: expireAt,
                time_left_seconds: timeLeft,
                episode_number: film.episode_number || base.episode_number || null
            };
        }

        // ════════════════════════════════════════════════════════
        // 🎯 UPDATE SUMMARY
        // ════════════════════════════════════════════════════════
        function updateSummary(films) {
            if (!summaryBar) return;
            var count = films.length;
            var totalSizeGB = (count * 0.2).toFixed(1);
            summaryBar.innerHTML = '<span>' + count + ' VIDEOS</span><span>' + totalSizeGB + ' GB</span>';
        }

        // ════════════════════════════════════════════════════════
        // 🎯 RENDER FILM LIST
        // ════════════════════════════════════════════════════════
        function renderFilms(films) {
            hideSkeleton();

            if (!films || films.length === 0) {
                if (movieListEl) { movieListEl.innerHTML = ''; movieListEl.style.display = 'none'; }
                if (emptyStateEl) emptyStateEl.style.display = 'flex';
                if (summaryBar) summaryBar.innerHTML = '<span>0 VIDEOS</span><span></span>';
                if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
                return;
            }

            if (emptyStateEl) emptyStateEl.style.display = 'none';
            if (movieListEl) {
                movieListEl.style.display = 'flex';
                movieListEl.style.flexDirection = 'column';
            }

            var html = '';
            films.forEach(function(rawFilm) {
                var film = getFilmData(rawFilm);
                var isExpired = film.time_left_seconds <= 0;
                var watchClass = isExpired ? 'watch-btn disabled' : 'watch-btn';
                var watchText = isExpired ? 'Expired' : 'WATCH NOW';

                var epBadge = '';
                if (film.episode_number) {
                    epBadge = '<span style="display:inline-block; font-size:10px; font-weight:800; background:#FFD700; color:#000; padding:2px 6px; border-radius:4px; margin-left:6px; vertical-align:middle; transform:translateY(-2px);">EP ' +
                              escapeHTML(film.episode_number) + '</span>';
                }

                html += '<div class="movie-item" data-id="' + escapeHTML(film.id) + '" data-expire-at="' + escapeHTML(film.expire_at || '') + '">' +
                    '<div class="poster-wrap">' +
                        '<img src="' + escapeHTML(film.poster_url) + '" alt="' + escapeHTML(film.title) + '" loading="lazy">' +
                    '</div>' +
                    '<div class="info">' +
                        '<div class="title">' + escapeHTML(film.title || 'Unknown Title') + ' ' + epBadge + '</div>' +
                        '<div class="meta">' + escapeHTML(film.quality) + ' • Paid: MK ' + Number(film.price_paid || 0).toLocaleString() + '</div>' +
                        '<div class="expiry">' + (isExpired ? 'Expired' : 'Expires in ' + formatTimeLeft(film.time_left_seconds)) + '</div>' +
                        '<a href="watch.html?id=' + encodeURIComponent(film.id) + '" class="' + watchClass + '" onclick="return handleWatchClick(event, this)">' + watchText + '</a>' +
                    '</div>' +
                '</div>';
            });

            if (movieListEl) movieListEl.innerHTML = html;
            updateSummary(films);
            startCountdowns();
        }

        // ════════════════════════════════════════════════════════
        // 🎯 COUNTDOWNS (optimized: cache elements once)
        // ════════════════════════════════════════════════════════
        function startCountdowns() {
            if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

            var items = Array.prototype.slice.call(document.querySelectorAll('.movie-item'));
            var trackedItems = items.map(function(item) {
                return {
                    expireAt: new Date(item.dataset.expireAt).getTime(),
                    expiryEl: item.querySelector('.expiry'),
                    watchLink: item.querySelector('.watch-btn')
                };
            });

            countdownInterval = setInterval(function() {
                var now = Date.now();
                trackedItems.forEach(function(t) {
                    if (!t.expiryEl || isNaN(t.expireAt)) return;
                    var diff = Math.floor((t.expireAt - now) / 1000);
                    if (diff <= 0) {
                        t.expiryEl.textContent = 'Expired';
                        if (t.watchLink && !t.watchLink.classList.contains('disabled')) {
                            t.watchLink.classList.add('disabled');
                            t.watchLink.textContent = 'Expired';
                        }
                    } else {
                        t.expiryEl.textContent = 'Expires in ' + formatTimeLeft(diff);
                    }
                });
            }, 1000);
        }

        // ════════════════════════════════════════════════════════
        // 🎯 HANDLE WATCH CLICK
        // ════════════════════════════════════════════════════════
        window.handleWatchClick = function(event, el) {
            if (el.classList.contains('disabled')) {
                event.preventDefault();
                showToast('This movie has expired. Please purchase again.');
                return false;
            }
            return true;
        };

        // ════════════════════════════════════════════════════════
        // 🎯 TOAST
        // ════════════════════════════════════════════════════════
        function showToast(msg) {
            if (!toast) return;
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(function() { toast.classList.remove('show'); }, 3000);
        }

        // ════════════════════════════════════════════════════════
        // 🎯 VISIBILITY REFRESH (tab return, if cache > 1 min)
        // ════════════════════════════════════════════════════════
        var visibilityBound = false;
        function setupVisibilityRefresh() {
            if (visibilityBound) return;
            visibilityBound = true;

            document.addEventListener('visibilitychange', function() {
                if (document.visibilityState !== 'visible') return;
                var cached = cacheRead(cacheKey);
                if (!cached) return;
                if (cached.age > SWR_THRESHOLD) {
                    fetchMyMovies().then(function(films) {
                        if (films) renderFilms(films);
                    }).catch(function() {});
                }
            });
        }

        // ════════════════════════════════════════════════════════
        // 🎯 PUBLIC REFRESH
        // ════════════════════════════════════════════════════════
        window.MyMoviesRefresh = function() {
            showSkeleton();
            return fetchMyMovies()
                .then(function(films) {
                    if (films) renderFilms(films);
                    return films;
                })
                .catch(function(e) {
                    hideSkeleton();
                    showToast('Refresh failed. Check connection.');
                    console.warn('Refresh failed:', e);
                });
        };

        // ════════════════════════════════════════════════════════
        // 🎯 INIT (zero-block, cache-first)
        // ════════════════════════════════════════════════════════
        function init() {
            if (appInited) return;
            appInited = true;

            var cached = cacheRead(cacheKey);

            if (cached) {
                // We have cache — render instantly (0ms).
                renderFilms(cached.data);

                if (cached.age > SWR_THRESHOLD) {
                    // Cache is 1-3 min (or >3 min) — SWR: revalidate silently.
                    fetchMyMovies()
                        .then(function(films) {
                            if (films) renderFilms(films);
                        })
                        .catch(function(e) {
                            console.warn('SWR refresh failed:', e);
                        });
                }
                // else: cache is 0-1 min — 0 network calls.

                setupVisibilityRefresh();
                return;
            }

            // No cache — blocking fetch with skeleton.
            showSkeleton();
            fetchMyMovies()
                .then(function(films) {
                    if (films) renderFilms(films);
                })
                .catch(function(err) {
                    console.error('Error:', err);
                    hideSkeleton();
                    showToast('Network error. Check connection.');
                    if (movieListEl && movieListEl.innerHTML === '') {
                        movieListEl.innerHTML = '<div style="text-align:center; padding: 20px; color: #aaa;">Network error. Please refresh.</div>';
                        movieListEl.style.display = 'flex';
                    }
                });

            setupVisibilityRefresh();
        }

        init();
    });

    // ════════════════════════════════════════════════════════════
    // 🎯 PAGE HIDE CLEANUP
    // ════════════════════════════════════════════════════════════
    window.addEventListener('pagehide', function() {
        // Countdown interval is cleared by page unload; nothing to do.
    });
})();

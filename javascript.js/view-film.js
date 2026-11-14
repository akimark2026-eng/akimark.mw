// view-film.js (v5.1 — Pro High-End Cache-First + Zero login-checker, no Share/Copy)
// Upgrades vs v5:
//  - Share (WhatsApp) and Copy Link buttons fully removed.
//  - All other v5 behavior preserved:
//      * login-checker REMOVED (auth is local-only).
//      * Film data cached 3min in sessionStorage (per film id).
//      * Translator profile cached 10min (per translator name).
//      * Zero-block init + SWR revalidation.
//      * Global 401 handler on all APIs (view, translator, follow, pay).
//      * dedupeFetch, visibility refresh, window.ViewFilmRefresh().

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';
    var LOGIN_REDIRECT = '/register';

    // ════════════════════════════════════════════════════════════
    // 🎯 CACHE CONFIG
    // ════════════════════════════════════════════════════════════
    var CACHE_FILM_PREFIX = 'akmark_cache_viewfilm_';  // per film id
    var CACHE_TRANS_PREFIX = 'akmark_cache_viewtrans_'; // per translator name
    var TTL_FILM = 3 * 60 * 1000;       // 3 min
    var TTL_TRANS = 10 * 60 * 1000;     // 10 min
    var SWR_THRESHOLD = 60 * 1000;      // 1 min — revalidate silently after this

    var SUPABASE_URL = 'https://vqmmsqtlszzugdyoyilu.supabase.co';
    var VIEW_API = SUPABASE_URL + '/functions/v1/viewing-film-api?action=get_movie';
    var TRANS_API_PREFIX = SUPABASE_URL + '/functions/v1/v1-admin-api?action=get_profile_by_name&name=';
    var FOLLOW_API_PREFIX = SUPABASE_URL + '/functions/v1/v1-admin-api?action=';
    var PAY_API = SUPABASE_URL + '/functions/v1/update-balance-api';

    var urlParams = new URLSearchParams(window.location.search);
    var filmId = urlParams.get('id');
    var seriesId = urlParams.get('series_id');
    var mode = urlParams.get('mode'); // 'single' when viewing a specific episode

    var skeletonLoader = document.getElementById('skeletonLoader');
    var errorState = document.getElementById('errorState');
    var errorMessage = document.getElementById('errorMessage');
    var filmDetails = document.getElementById('filmDetails');
    var watchBtn = document.getElementById('watchBtn');
    var watchBtnText = document.getElementById('watchBtnText');
    var statusMessage = document.getElementById('statusMessage');
    var translatorProfile = document.getElementById('translatorProfile');
    var translatorName = document.getElementById('translatorName');
    var translatorAvatar = document.getElementById('translatorAvatar');
    var translatorFollowers = document.getElementById('translatorFollowers');
    var followBtn = document.getElementById('followBtn');
    var episodesSection = document.getElementById('episodesSection');
    var episodesList = document.getElementById('episodesList');

    // NOTE: shareWhatsAppBtn & copyLinkBtn removed in v5.1.

    var filmData = null;
    var translatorData = null;
    var isFollowing = false;
    var adminId = null;
    var episodes = [];
    var currentMovieId = null;
    var filmCacheKey = null;
    var transCacheKey = null;
    var appInited = false;

    var DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23A7A7A7'><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";
    var DEFAULT_POSTER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23333'><path d='M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9 8h2v8H9zm4 0h2v8h-2z'/></svg>";

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
    // 🎯 SAFE STORAGE + CACHE HELPERS
    // ════════════════════════════════════════════════════════════
    function safeGet(storage, key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function safeSet(storage, key, val) { try { storage.setItem(key, val); } catch (e) {} }
    function safeRemove(storage, key) { try { storage.removeItem(key); } catch (e) {} }

    function sessionCacheRead(key, ttl) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try {
            var p = JSON.parse(raw);
            var age = Date.now() - p.ts;
            if (age > ttl) return null;
            return { data: p.data, age: age };
        } catch (e) { return null; }
    }
    function sessionCacheReadRaw(key) {
        var raw = safeGet(sessionStorage, key);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    function sessionCacheWrite(key, data) {
        safeSet(sessionStorage, key, JSON.stringify({ ts: Date.now(), data: data }));
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TOKEN / SESSION (LOCAL ONLY — no login-checker)
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

    function setUser(user) {
        safeSet(localStorage, USER_KEY, JSON.stringify(user));
        setCookie('akmark_user_logged', 'true', 7);
    }

    function clearSession() {
        var token = getToken();

        safeRemove(localStorage, TOKEN_KEY);
        safeRemove(sessionStorage, TOKEN_KEY);
        safeRemove(localStorage, 'akmark_refresh_token');
        safeRemove(sessionStorage, 'akmark_refresh_token');
        safeRemove(localStorage, USER_KEY);
        eraseCookie(TOKEN_KEY);
        eraseCookie('akmark_user_logged');

        if (filmCacheKey) safeRemove(sessionStorage, filmCacheKey);
        if (transCacheKey) safeRemove(sessionStorage, transCacheKey);
    }

    function handleAuthError(status) {
        if (status === 401 || status === 403) {
            clearSession();
            window.location.href = LOGIN_REDIRECT;
            return true;
        }
        return false;
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 DEDUPE FETCH + GLOBAL 401
    // ════════════════════════════════════════════════════════════
    var inflight = {};
    function dedupeFetch(url, options) {
        var key = url + '|' + (options && options.headers ? JSON.stringify(options.headers) : '');
        if (inflight[key]) return inflight[key];

        var p = fetch(url, options).then(function(r) {
            if (r.status === 401 || r.status === 403) {
                handleAuthError(r.status);
            }
            return r;
        }).finally(function() {
            delete inflight[key];
        });
        inflight[key] = p;
        return p;
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 XSS PROTECTION + FORMATTERS
    // ════════════════════════════════════════════════════════════
    function escapeHTML(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    function formatFollowers(count) {
        count = Number(count) || 0;
        if (count >= 1000) {
            var val = count / 1000;
            return (val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)) + 'K';
        }
        return count + '';
    }

    function isValidUUID(uuid) {
        if (!uuid) return false;
        var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(uuid);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 AUTH CHECK (LOCAL ONLY)
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = LOGIN_REDIRECT;
            return false;
        }
        setTokenInAllPlaces(token);
        return true;
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 LOAD FILM (CACHE-FIRST + SWR)
    // ════════════════════════════════════════════════════════════
    function fetchFilmFromServer() {
        return dedupeFetch(VIEW_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + getToken()
            },
            body: JSON.stringify({ movie_id: filmId })
        })
        .then(function(r) {
            if (r.status === 401 || r.status === 403) return null; // handled by dedupeFetch
            return r.json();
        })
        .then(function(data) {
            if (!data) return null;
            if (!data.success || !data.movie) throw new Error(data.error || 'Film not found');
            return { film: data.movie, episodes: data.episodes || [] };
        });
    }

    function applyFilmData(payload) {
        filmData = payload.film;
        episodes = payload.episodes || [];
        currentMovieId = filmData.id;

        if (episodes.length > 0 && mode !== 'single') {
            renderEpisodes();
            if (episodesSection) episodesSection.style.display = 'block';
        } else if (episodesSection) {
            episodesSection.style.display = 'none';
        }

        populateFilmData(filmData);
        loadTranslatorProfile();
    }

    function showFilm() {
        setTimeout(function() {
            if (skeletonLoader) skeletonLoader.classList.remove('show');
            if (filmDetails) filmDetails.classList.add('show');
        }, 50);
    }

    function loadFilm() {
        if (!filmId || !isValidUUID(filmId)) {
            showError('Invalid film ID format.');
            return;
        }

        filmCacheKey = CACHE_FILM_PREFIX + filmId;
        var cached = sessionCacheRead(filmCacheKey, TTL_FILM);

        if (cached) {
            applyFilmData(cached.data);
            showFilm();

            if (cached.age > SWR_THRESHOLD) {
                fetchFilmFromServer()
                    .then(function(payload) {
                        if (!payload) return;
                        sessionCacheWrite(filmCacheKey, payload);
                        applyFilmData(payload);
                    })
                    .catch(function(e) { console.warn('SWR film refresh failed:', e); });
            }
            return;
        }

        if (skeletonLoader) skeletonLoader.classList.add('show');
        if (errorState) errorState.style.display = 'none';
        if (filmDetails) filmDetails.classList.remove('show');

        fetchFilmFromServer()
            .then(function(payload) {
                if (!payload) return;
                sessionCacheWrite(filmCacheKey, payload);
                applyFilmData(payload);
                showFilm();
            })
            .catch(function(err) {
                console.error('Error loading film:', err.message);
                if (skeletonLoader) skeletonLoader.classList.remove('show');
                showError(err.message === 'Failed to fetch'
                    ? 'Network error. Please check your connection.'
                    : err.message);
            });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 POPULATE FILM DATA (with improved poster fallback)
    // ════════════════════════════════════════════════════════════
    function populateFilmData(movie) {
        var posterEl = document.getElementById('filmPoster');

        function applyPosterFallback() {
            var fallbackSrc = null;
            if (episodes && episodes.length > 0) {
                for (var i = 0; i < episodes.length; i++) {
                    if (episodes[i].poster_url && episodes[i].poster_url.trim() !== '') {
                        fallbackSrc = episodes[i].poster_url;
                        break;
                    }
                }
            }
            posterEl.onerror = null;
            posterEl.src = fallbackSrc || DEFAULT_POSTER;
        }

        posterEl.onerror = applyPosterFallback;

        if (movie.poster_url && movie.poster_url.trim() !== '') {
            posterEl.src = movie.poster_url;
        } else {
            applyPosterFallback();
        }

        var titleEl = document.getElementById('filmTitle');
        if (titleEl) {
            var titleText = movie.title || '';
            if (movie.episode_number) {
                titleText += ' (part ' + movie.episode_number + ')';
            }
            titleEl.textContent = titleText;
        }

        var price = Number(movie.price || 0);
        var btnText = document.getElementById('watchBtnText');
        if (btnText) btnText.textContent = 'WATCH NOW MK ' + price.toLocaleString();
    }

    function renderEpisodes() {
        if (!episodesList) return;
        episodesList.innerHTML = '';
        episodes.forEach(function(ep, index) {
            var item = document.createElement('div');
            item.className = 'episode-item' + (ep.id === currentMovieId ? ' active' : '');

            var thumb = document.createElement('div');
            thumb.className = 'episode-thumb';
            var img = document.createElement('img');
            img.onerror = function() {
                this.onerror = null;
                this.src = (filmData && filmData.poster_url) ? filmData.poster_url : DEFAULT_POSTER;
            };
            img.src = ep.poster_url || '';
            if (!ep.poster_url) {
                img.onerror();
            }
            thumb.appendChild(img);

            var playOverlay = document.createElement('div');
            playOverlay.className = 'play-overlay';
            playOverlay.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
            thumb.appendChild(playOverlay);

            var dur = document.createElement('span');
            dur.className = 'episode-duration';
            dur.textContent = 'EP ' + escapeHTML(ep.episode_number || (index + 1));
            thumb.appendChild(dur);

            var textContainer = document.createElement('div');
            textContainer.className = 'episode-text';

            var title = document.createElement('div');
            title.className = 'episode-title';
            var titleText = ep.title || '';
            if (ep.episode_number) titleText += ' (part ' + ep.episode_number + ')';
            title.textContent = escapeHTML(titleText);

            var price = document.createElement('div');
            price.className = 'episode-price';
            price.textContent = 'MK ' + Number(ep.price || 0).toLocaleString();

            textContainer.appendChild(title);
            textContainer.appendChild(price);

            item.appendChild(thumb);
            item.appendChild(textContainer);

            item.addEventListener('click', function() {
                window.location.href = 'view-film.html?id=' + ep.id + '&mode=single';
            });

            episodesList.appendChild(item);
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TRANSLATOR PROFILE (CACHE-FIRST + SWR)
    // ════════════════════════════════════════════════════════════
    function fetchTranslatorFromServer(name) {
        var url = TRANS_API_PREFIX + encodeURIComponent(name);
        return dedupeFetch(url, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + getToken(),
                'Content-Type': 'application/json'
            }
        })
        .then(function(r) {
            if (r.status === 401 || r.status === 403) return null;
            return r.json();
        })
        .then(function(data) {
            if (!data) return null;
            if (data.success && data.admin) {
                return {
                    admin: data.admin,
                    isFollowing: !!data.admin.is_following
                };
            }
            return null;
        });
    }

    function applyTranslatorData(payload) {
        if (!payload) return;
        translatorData = payload.admin;
        adminId = payload.admin.id;
        isFollowing = payload.isFollowing;
        if (translatorAvatar) translatorAvatar.src = payload.admin.profile_image || DEFAULT_AVATAR;
        if (translatorFollowers) translatorFollowers.textContent = formatFollowers(payload.admin.followers_count) + ' followers';
        updateFollowButton();
    }

    function loadTranslatorProfile() {
        if (!filmData || !filmData.translator_name) {
            if (translatorProfile) translatorProfile.style.display = 'none';
            return;
        }

        if (translatorName) translatorName.textContent = filmData.translator_name;
        if (translatorFollowers) translatorFollowers.textContent = '0 followers';
        if (translatorProfile) translatorProfile.style.display = 'flex';
        if (translatorAvatar) translatorAvatar.src = DEFAULT_AVATAR;

        transCacheKey = CACHE_TRANS_PREFIX + filmData.translator_name.toLowerCase();
        var cached = sessionCacheRead(transCacheKey, TTL_TRANS);

        if (cached) {
            applyTranslatorData(cached.data);

            if (cached.age > SWR_THRESHOLD) {
                fetchTranslatorFromServer(filmData.translator_name)
                    .then(function(payload) {
                        if (!payload) return;
                        sessionCacheWrite(transCacheKey, payload);
                        applyTranslatorData(payload);
                    })
                    .catch(function(e) { console.warn('SWR translator refresh failed:', e); });
            }
            return;
        }

        fetchTranslatorFromServer(filmData.translator_name)
            .then(function(payload) {
                if (!payload) return;
                sessionCacheWrite(transCacheKey, payload);
                applyTranslatorData(payload);
            })
            .catch(function(err) { console.warn('Translator profile fetch failed:', err); });
    }

    function toggleFollow() {
        if (!adminId) return;
        var action = isFollowing ? 'unfollow' : 'follow';
        var url = FOLLOW_API_PREFIX + action + '&admin_id=' + adminId;

        dedupeFetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + getToken()
            },
            body: JSON.stringify({})
        })
        .then(function(response) {
            if (response.status === 401 || response.status === 403) return null;
            return response.json();
        })
        .then(function(data) {
            if (!data) return;
            if (data.success) {
                isFollowing = !isFollowing;
                if (translatorFollowers) translatorFollowers.textContent = formatFollowers(data.followers_count) + ' followers';
                updateFollowButton();
                if (transCacheKey && translatorData) {
                    sessionCacheWrite(transCacheKey, {
                        admin: Object.assign({}, translatorData, { followers_count: data.followers_count }),
                        isFollowing: isFollowing
                    });
                }
            } else {
                showToast(data.error || 'Follow failed', true);
            }
        })
        .catch(function(err) {
            console.error('Error toggling follow:', err);
            showToast('Server error', true);
        });
    }

    function updateFollowButton() {
        if (!followBtn) return;
        if (isFollowing) {
            followBtn.textContent = 'Following';
            followBtn.classList.add('following');
        } else {
            followBtn.textContent = 'Follow';
            followBtn.classList.remove('following');
        }
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 TOAST
    // ════════════════════════════════════════════════════════════
    function showToast(msg, isError) {
        var toast = document.getElementById('toast');
        var toastMessage = document.getElementById('toastMessage');
        if (!toast || !toastMessage) return;
        toastMessage.textContent = msg;
        toast.classList.add('visible');
        toast.style.borderColor = isError ? '#ff6b6b' : 'var(--green)';
        setTimeout(function() { toast.classList.remove('visible'); }, 3000);
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 WATCH (PAYMENT)
    // ════════════════════════════════════════════════════════════
    function handleWatch() {
        if (!filmData) return;
        var token = getToken();
        if (!token) {
            window.location.href = LOGIN_REDIRECT;
            return;
        }

        if (watchBtn) watchBtn.classList.add('loading');
        if (watchBtnText) watchBtnText.textContent = 'Processing...';
        if (statusMessage) statusMessage.classList.remove('show');

        dedupeFetch(PAY_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ film_id: currentMovieId || filmData.id })
        })
        .then(function(response) {
            if (response.status === 401 || response.status === 403) return null;
            return response.json();
        })
        .then(function(data) {
            if (!data) return;
            if (watchBtn) watchBtn.classList.remove('loading');
            if (data.success) {
                if (watchBtnText) watchBtnText.textContent = 'PAYMENT SUCCESSFUL';
                if (watchBtn) watchBtn.disabled = true;
                if (statusMessage) {
                    statusMessage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Payment Success!';
                    statusMessage.className = 'status-message show success';
                }
                setTimeout(function() {
                    window.location.href = 'watch.html?id=' + (currentMovieId || filmData.id);
                }, 1000);
            } else {
                var price = Number(filmData.price || 0);
                if (watchBtnText) watchBtnText.textContent = 'WATCH NOW MK ' + price.toLocaleString();
                if (statusMessage) {
                    statusMessage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg> ' + escapeHTML(data.error || 'Payment failed');
                    statusMessage.className = 'status-message show error';
                }
                showToast(data.error || 'Payment failed', true);
            }
        })
        .catch(function(err) {
            if (watchBtn) watchBtn.classList.remove('loading');
            var price = Number(filmData.price || 0);
            if (watchBtnText) watchBtnText.textContent = 'WATCH NOW MK ' + price.toLocaleString();
            if (statusMessage) {
                statusMessage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg> Network Error';
                statusMessage.className = 'status-message show error';
            }
            showToast('Network error. Please try again.', true);
        });
    }

    function showError(message) {
        if (skeletonLoader) skeletonLoader.classList.remove('show');
        if (errorState) {
            errorState.style.display = 'flex';
            if (errorMessage) errorMessage.textContent = message;
        }
        if (filmDetails) filmDetails.classList.remove('show');
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 VISIBILITY REFRESH
    // ════════════════════════════════════════════════════════════
    var visibilityBound = false;
    function setupVisibilityRefresh() {
        if (visibilityBound) return;
        visibilityBound = true;

        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState !== 'visible') return;
            if (!getToken()) {
                window.location.href = LOGIN_REDIRECT;
                return;
            }
            if (filmCacheKey && filmId) {
                var raw = sessionCacheReadRaw(filmCacheKey);
                if (raw && raw.ts && (Date.now() - raw.ts) > SWR_THRESHOLD) {
                    fetchFilmFromServer().then(function(payload) {
                        if (!payload) return;
                        sessionCacheWrite(filmCacheKey, payload);
                        applyFilmData(payload);
                    }).catch(function() {});
                }
            }
        });
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 PUBLIC REFRESH API
    // ════════════════════════════════════════════════════════════
    window.ViewFilmRefresh = function() {
        if (!filmId) return Promise.resolve();
        return fetchFilmFromServer()
            .then(function(payload) {
                if (!payload) return null;
                sessionCacheWrite(filmCacheKey, payload);
                applyFilmData(payload);
                return payload;
            })
            .catch(function(e) { console.warn('Manual refresh failed:', e); });
    };

    // ════════════════════════════════════════════════════════════
    // 🎯 INIT
    // ════════════════════════════════════════════════════════════
    function init() {
        if (appInited) return;
        if (!checkLogin()) return;
        appInited = true;

        loadFilm();
        if (watchBtn) watchBtn.addEventListener('click', handleWatch);
        if (followBtn) followBtn.addEventListener('click', toggleFollow);
        setupVisibilityRefresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

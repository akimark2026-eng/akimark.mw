// view-film.js (v3 — Pro High-End with Robust Auth, XSS Protection, and Optimistic Rendering)
// Fixes auto-logout in WebView by using Cookie fallback and smart error handling.

(function() {
    'use strict';

    var TOKEN_KEY = 'akmark_token';
    var USER_KEY = 'akmark_user';

    var urlParams = new URLSearchParams(window.location.search);
    var filmId = urlParams.get('id');
    var seriesId = urlParams.get('series_id');
    var mode = urlParams.get('mode'); // 'single' when viewing a specific part

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

    var filmData = null;
    var translatorData = null;
    var isFollowing = false;
    var adminId = null;
    var episodes = [];
    var currentMovieId = null;

    var DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23A7A7A7'><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";

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
        if (!token) token = getCookie(TOKEN_KEY);
        
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

    function setUser(user) { 
        localStorage.setItem(USER_KEY, JSON.stringify(user)); 
        setCookie('akmark_user_logged', 'true', 7);
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
    // 🎯 XSS PROTECTION
    // ════════════════════════════════════════════════════════════
    function escapeHTML(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, function(m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    // Format followers: 1000 -> 1K, 1100 -> 1.1K, 100000 -> 100K
    function formatFollowers(count) {
        count = Number(count) || 0;
        if (count >= 1000) {
            var val = count / 1000;
            return (val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)) + 'K';
        }
        return count + '';
    }

    // ════════════════════════════════════════════════════════════
    // 🎯 BULLETPROOF AUTH CHECK
    // ════════════════════════════════════════════════════════════
    function checkLogin() {
        var token = getToken();
        if (!token) {
            window.location.href = '/register';
            return;
        }
        setTokenInAllPlaces(token);

        // 1. Optimistic Render: Load film immediately (Don't wait for auth network)
        loadFilm();

        // 2. Background Auth Check (Fire and Forget)
        fetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/login-checker', {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(response => {
            // Only logout if server explicitly says Unauthorized/Forbidden
            if (response.status === 401 || response.status === 403) {
                console.warn('Session invalid. Logging out.');
                clearSession(); 
                window.location.href = '/register'; 
                return null;
            }
            if (!response.ok) throw new Error('Network error');
            return response.json();
        })
        .then(data => {
            if (!data) return;
            if (!data.valid) { 
                clearSession(); 
                window.location.href = '/register'; 
            } else if (data.user) { 
                setUser(data.user); 
            }
        })
        .catch(err => {
            // 🎯 CRITICAL FIX: Ignore network errors / WebView transitions. DO NOT LOGOUT.
            console.warn('Auth check ignored (WebView transition):', err);
        });
    }

    function loadFilm() {
        if (!filmId || !isValidUUID(filmId)) { showError('Invalid film ID format.'); return; }
        if (skeletonLoader) skeletonLoader.classList.add('show');
        if (errorState) errorState.style.display = 'none';
        if (filmDetails) filmDetails.classList.remove('show');

        var url = 'https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/viewing-film-api?action=get_movie';
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
            body: JSON.stringify({ movie_id: filmId })
        })
        .then(response => response.json())
        .then(data => {
            if (!data.success || !data.movie) throw new Error(data.error || 'Film not found');
            filmData = data.movie;
            episodes = data.episodes || [];
            currentMovieId = filmData.id;

            // If mode is 'single', hide the episodes list (user clicked on a specific part)
            if (episodes.length > 0 && mode !== 'single') {
                renderEpisodes();
                episodesSection.style.display = 'block';
            } else {
                episodesSection.style.display = 'none';
            }

            populateFilmData(filmData);
            loadTranslatorProfile();
            if (skeletonLoader) skeletonLoader.classList.remove('show');
            if (filmDetails) filmDetails.classList.add('show');
        })
        .catch(err => { 
            console.error('Error loading film:', err.message); 
            if (skeletonLoader) skeletonLoader.classList.remove('show'); 
            // If it's a network error, show a specific message
            showError(err.message === 'Failed to fetch' ? 'Network error. Please check your connection.' : err.message); 
        });
    }

    // Populate Poster, Title (with Part X), and Price inside Button
    function populateFilmData(movie) {
        var posterEl = document.getElementById('filmPoster');
        if (posterEl) posterEl.src = movie.poster_url || '';
        
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

    // Render episodes as minimalist cards (Title at top, Price at bottom)
    function renderEpisodes() {
        episodesList.innerHTML = '';
        episodes.forEach(function(ep, index) {
            var item = document.createElement('div');
            item.className = 'episode-item' + (ep.id === currentMovieId ? ' active' : '');
            
            // Thumbnail
            var thumb = document.createElement('div');
            thumb.className = 'episode-thumb';
            var img = document.createElement('img');
            img.src = ep.poster_url || '';
            thumb.appendChild(img);
            
            // Play Overlay
            var playOverlay = document.createElement('div');
            playOverlay.className = 'play-overlay';
            playOverlay.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
            thumb.appendChild(playOverlay);
            
            // Duration Overlay (EP X)
            var dur = document.createElement('span');
            dur.className = 'episode-duration';
            dur.textContent = 'EP ' + escapeHTML(ep.episode_number || (index + 1));
            thumb.appendChild(dur);
            
            // Text Container for Title and Price
            var textContainer = document.createElement('div');
            textContainer.className = 'episode-text';
            
            // Title (with Part X)
            var title = document.createElement('div');
            title.className = 'episode-title';
            var titleText = ep.title || '';
            if (ep.episode_number) {
                titleText += ' (part ' + ep.episode_number + ')';
            }
            title.textContent = escapeHTML(titleText); // 🎯 XSS Protection
            
            // Price (bottom)
            var price = document.createElement('div');
            price.className = 'episode-price';
            price.textContent = 'MK ' + Number(ep.price || 0).toLocaleString();
            
            textContainer.appendChild(title);
            textContainer.appendChild(price);
            
            item.appendChild(thumb);
            item.appendChild(textContainer);
            
            // Clicking part navigates to single mode page
            item.addEventListener('click', function() {
                window.location.href = 'view-film.html?id=' + ep.id + '&mode=single';
            });
            
            episodesList.appendChild(item);
        });
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

        var url = 'https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/v1-admin-api?action=get_profile_by_name&name=' + encodeURIComponent(filmData.translator_name);
        fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' } })
        .then(response => response.json())
        .then(data => {
            if (data.success && data.admin) {
                translatorData = data.admin;
                adminId = data.admin.id;
                if (translatorAvatar) translatorAvatar.src = data.admin.profile_image || DEFAULT_AVATAR;
                if (translatorFollowers) translatorFollowers.textContent = formatFollowers(data.admin.followers_count) + ' followers';
                isFollowing = data.admin.is_following;
                updateFollowButton();
            }
        })
        .catch(err => console.warn('Translator profile fetch failed:', err));
    }

    function toggleFollow() {
        if (!adminId) return;
        var action = isFollowing ? 'unfollow' : 'follow';
        fetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/v1-admin-api?action=' + action + '&admin_id=' + adminId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
            body: JSON.stringify({})
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                isFollowing = !isFollowing;
                if (translatorFollowers) translatorFollowers.textContent = formatFollowers(data.followers_count) + ' followers';
                updateFollowButton();
            } else {
                showToast(data.error || 'Follow failed', true);
            }
        })
        .catch(err => { console.error('Error toggling follow:', err); showToast('Server error', true); });
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

    function handleWatch() {
        if (!filmData) return;
        var token = getToken();
        if (!token) return;

        watchBtn.classList.add('loading');
        watchBtnText.textContent = 'Processing...';
        statusMessage.classList.remove('show');

        fetch('https://vqmmsqtlszzugdyoyilu.supabase.co/functions/v1/update-balance-api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ film_id: currentMovieId || filmData.id })
        })
        .then(response => response.json())
        .then(data => {
            watchBtn.classList.remove('loading');
            if (data.success) {
                watchBtnText.textContent = 'PAYMENT SUCCESSFUL';
                watchBtn.disabled = true;
                statusMessage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Payment Success!';
                statusMessage.className = 'status-message show success';
                setTimeout(function() {
                    window.location.href = 'watch.html?id=' + (currentMovieId || filmData.id);
                }, 1000);
            } else {
                var price = Number(filmData.price || 0);
                watchBtnText.textContent = 'WATCH NOW MK ' + price.toLocaleString();
                statusMessage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg> ' + escapeHTML(data.error || 'Payment failed');
                statusMessage.className = 'status-message show error';
                showToast(data.error || 'Payment failed', true);
            }
        })
        .catch(function(err) {
            watchBtn.classList.remove('loading');
            var price = Number(filmData.price || 0);
            watchBtnText.textContent = 'WATCH NOW MK ' + price.toLocaleString();
            statusMessage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg> Network Error';
            statusMessage.className = 'status-message show error';
            showToast('Network error. Please try again.', true);
        });
    }

    function showToast(msg, isError) {
        var toast = document.getElementById('toast');
        if (!toast) return;
        var span = toast.querySelector('span');
        if (span) span.textContent = msg;
        toast.classList.add('visible');
        toast.style.borderColor = isError ? '#ff6b6b' : 'var(--border-subtle)';
        setTimeout(function() { toast.classList.remove('visible'); }, 3000);
    }

    function showError(message) {
        if (skeletonLoader) skeletonLoader.classList.remove('show');
        if (errorState) { errorState.style.display = 'flex'; if (errorMessage) errorMessage.textContent = message; }
        if (filmDetails) filmDetails.classList.remove('show');
    }

    function isValidUUID(uuid) {
        var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(uuid);
    }

    function init() {
        checkLogin();
        if (watchBtn) watchBtn.addEventListener('click', handleWatch);
        if (followBtn) followBtn.addEventListener('click', toggleFollow);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

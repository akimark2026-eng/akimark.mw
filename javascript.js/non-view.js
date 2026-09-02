// non-view.js (Updated for back navigation, follow redirect, phone normalization, and followers hidden)

(function() {
    'use strict';

    const SUPABASE_URL = window.SUPABASE_URL;
    const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const urlParams = new URLSearchParams(window.location.search);
    const movieId = urlParams.get('id');
    const mode = urlParams.get('mode'); // 'single' when viewing a specific part

    // DOM Elements
    const skeletonLoader = document.getElementById('skeletonLoader');
    const errorState = document.getElementById('errorState');
    const errorMessage = document.getElementById('errorMessage');
    const filmDetails = document.getElementById('filmDetails');
    const watchBtn = document.getElementById('watchBtn');
    const watchBtnText = document.getElementById('watchBtnText');
    const statusMessage = document.getElementById('statusMessage');
    const translatorProfile = document.getElementById('translatorProfile');
    const translatorName = document.getElementById('translatorName');
    const translatorAvatar = document.getElementById('translatorAvatar');
    const translatorFollowers = document.getElementById('translatorFollowers');
    const followBtn = document.getElementById('followBtn');
    const episodesSection = document.getElementById('episodesSection');
    const episodesList = document.getElementById('episodesList');
    const filmPoster = document.getElementById('filmPoster');
    const filmTitle = document.getElementById('filmTitle');

    // Payment DOM
    const modalOverlay = document.getElementById('modalOverlay');
    const phoneInput = document.getElementById('phoneNumber');
    const confirmBtn = document.getElementById('confirmBtn');
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    let selectedMethod = null;

    // State
    let filmData = null;
    let episodes = [];
    let currentMovieId = null;
    let adminId = null;
    let isFollowing = false;

    const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23A7A7A7'><path d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/></svg>";

    // ===== TOAST FUNCTION =====
    function showToast(msg, isError = false) {
        toastMessage.textContent = msg;
        toast.classList.remove('error', 'success');
        if (isError) toast.classList.add('error');
        else toast.classList.add('success');
        
        const iconSvg = toast.querySelector('svg');
        if (isError) {
            iconSvg.innerHTML = '<path d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>';
        } else {
            iconSvg.innerHTML = '<path d="M20 6L9 17l-5-5"/>';
        }
        
        toast.classList.add('visible');
        setTimeout(() => { toast.classList.remove('visible'); }, 4000);
    }

    // ===== FOLLOWERS FORMAT (hidden for non-login) =====
    // We won't use this function since we hide followers.

    // ===== LOAD MOVIE =====
    async function ensureSession() {
        let { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            const { error } = await supabase.auth.signInAnonymously();
            if (error) throw new Error("Anonymous auth failed. Please check Supabase settings.");
            session = (await supabase.auth.getSession()).data.session;
        }
        return session;
    }

    async function loadFilm() {
        if (!movieId || !isValidUUID(movieId)) { showError('Invalid film ID format.'); return; }
        if (skeletonLoader) skeletonLoader.classList.add('show');
        if (errorState) errorState.style.display = 'none';
        if (filmDetails) filmDetails.classList.remove('show');

        try {
            const session = await ensureSession();
            const token = session.access_token;

            const res = await fetch(`${SUPABASE_URL}/functions/v1/non-viewing-film-api?action=get_movie`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ movie_id: movieId })
            });
            const data = await res.json();
            if (!res.ok || !data.success || !data.movie) throw new Error(data.error || 'Film not found');

            filmData = data.movie;
            episodes = data.episodes || [];
            currentMovieId = filmData.id;

            // Show episodes if series
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
        } catch (err) {
            console.error('Error loading film:', err.message);
            if (skeletonLoader) skeletonLoader.classList.remove('show');
            showError(err.message);
        }
    }

    // ===== POPULATE DATA =====
    function populateFilmData(movie) {
        if (filmPoster) filmPoster.src = movie.poster_url || '';
        
        if (filmTitle) {
            var titleText = movie.title || '';
            if (movie.episode_number) {
                titleText += ' (part ' + movie.episode_number + ')';
            }
            filmTitle.textContent = titleText;
        }
        
        var price = Number(movie.price || 0);
        if (watchBtnText) watchBtnText.textContent = 'WATCH NOW MK ' + price.toLocaleString();
    }

    // ===== RENDER EPISODES =====
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
            
            // Duration Overlay
            var dur = document.createElement('span');
            dur.className = 'episode-duration';
            dur.textContent = 'EP ' + (ep.episode_number || (index + 1));
            thumb.appendChild(dur);
            
            // Text Container
            var textContainer = document.createElement('div');
            textContainer.className = 'episode-text';
            
            var title = document.createElement('div');
            title.className = 'episode-title';
            var titleText = ep.title || '';
            if (ep.episode_number) {
                titleText += ' (part ' + ep.episode_number + ')';
            }
            title.textContent = titleText;
            
            var price = document.createElement('div');
            price.className = 'episode-price';
            price.textContent = 'MK ' + Number(ep.price || 0).toLocaleString();
            
            textContainer.appendChild(title);
            textContainer.appendChild(price);
            
            item.appendChild(thumb);
            item.appendChild(textContainer);
            
            // Click navigates to single mode (history back will return to this page)
            item.addEventListener('click', function() {
                window.location.href = 'non-view.html?id=' + ep.id + '&mode=single';
            });
            
            episodesList.appendChild(item);
        });
    }

    // ===== TRANSLATOR PROFILE (followers hidden, follow redirects to login) =====
    function loadTranslatorProfile() {
        if (!filmData || !filmData.translator_name) {
            if (translatorProfile) translatorProfile.style.display = 'none';
            return;
        }
        if (translatorName) translatorName.textContent = filmData.translator_name;
        // Hide followers for non-login users
        if (translatorFollowers) translatorFollowers.style.display = 'none';
        if (translatorProfile) translatorProfile.style.display = 'flex';
        if (translatorAvatar) translatorAvatar.src = DEFAULT_AVATAR;

        // Try to fetch profile but without token, it may fail; we ignore followers.
        var token = localStorage.getItem('akmark_token');
        if (!token) {
            // No login, just show name, no followers, follow button will redirect to login
            adminId = null;
            updateFollowButton();
            return;
        }

        var url = `${SUPABASE_URL}/functions/v1/v1-admin-api?action=get_profile_by_name&name=` + encodeURIComponent(filmData.translator_name);
        fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' } })
        .then(response => response.json())
        .then(data => {
            if (data.success && data.admin) {
                adminId = data.admin.id;
                if (translatorAvatar) translatorAvatar.src = data.admin.profile_image || DEFAULT_AVATAR;
                // Still hide followers
                if (translatorFollowers) translatorFollowers.style.display = 'none';
                isFollowing = data.admin.is_following;
                updateFollowButton();
            }
        })
        .catch(err => console.error('Error loading translator profile:', err));
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

    function toggleFollow() {
        if (!adminId) {
            // Redirect to login page if not logged in
            window.location.href = '/login';
            return;
        }
        var action = isFollowing ? 'unfollow' : 'follow';
        fetch(`${SUPABASE_URL}/functions/v1/v1-admin-api?action=` + action + '&admin_id=' + adminId, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (localStorage.getItem('akmark_token') || '') },
            body: JSON.stringify({})
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                isFollowing = !isFollowing;
                updateFollowButton();
            } else {
                showToast(data.error || 'Follow failed', true);
            }
        })
        .catch(err => { console.error('Error toggling follow:', err); showToast('Server error', true); });
    }

    // ===== PAYMENT SYSTEM =====
    function detectNetwork(phone) {
        if (!phone) return null;
        const cleaned = phone.replace(/\D/g, '').replace(/^0+/, '');
        if (/^(88|89|81)/.test(cleaned)) return 'tnm';
        if (/^(99|98|97)/.test(cleaned)) return 'airtel';
        return null;
    }

    // Normalize phone: if 9 digits starting with 8 or 9, prepend 0
    function normalizePhone(phone) {
        let cleaned = phone.replace(/\D/g, '');
        if (cleaned.length === 9 && /^[89]/.test(cleaned)) {
            cleaned = '0' + cleaned;
        }
        return cleaned;
    }

    function selectMethod(method) {
        selectedMethod = method;
        document.querySelectorAll('.method-card').forEach(card => card.classList.toggle('selected', card.dataset.method === method));
    }

    function autoSelectNetwork() {
        const detected = detectNetwork(phoneInput.value);
        if (detected) selectMethod(detected);
    }

    function openPaymentSheet() {
        modalOverlay.classList.add('active');
    }

    function closeModal(event) {
        if (event && event.target !== modalOverlay && event.target !== modalOverlay.firstChild) return;
        modalOverlay.classList.remove('active');
    }

    async function confirmPayment() {
        const rawPhone = phoneInput.value.trim();
        const phone = normalizePhone(rawPhone);
        phoneInput.value = phone; // update input with normalized phone

        const method = selectedMethod || detectNetwork(phone);
        if (!method) {
            showToast('Select a payment method or enter a valid phone number.', true);
            return;
        }
        if (!/^0[89]\d{8}$/.test(phone)) {
            showToast('Enter a valid phone number (09XXXXXXXX or 9XXXXXXXX).', true);
            return;
        }

        const price = Number(filmData.price || 0);

        confirmBtn.disabled = true;
        confirmBtn.textContent = 'PAYING...';

        try {
            const session = await ensureSession();
            const token = session.access_token;

            // Step 1: Initialize
            const initRes = await fetch(`${SUPABASE_URL}/functions/v1/non-deposit-api`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                    action: 'initialize',
                    amount: price,
                    phone,
                    method,
                    movie_id: currentMovieId || movieId
                })
            });
            const initData = await initRes.json();
            if (!initData.success) throw new Error(initData.error || 'Payment initiation failed');

            const txRef = initData.tx_ref;

            // Step 2: Poll non-verify-api every 3 seconds
            const pollInterval = setInterval(async () => {
                const verifyRes = await fetch(`${SUPABASE_URL}/functions/v1/non-verify-api`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ tx_ref: txRef, movie_id: currentMovieId || movieId })
                });
                const verifyData = await verifyRes.json();

                if (verifyData.success) {
                    clearInterval(pollInterval);
                    showToast('Payment Successful!', false);
                    setTimeout(() => {
                        window.location.href = 'watch.html?id=' + (currentMovieId || movieId);
                    }, 1500);
                } else if (verifyData.status === 'failed') {
                    clearInterval(pollInterval);
                    showToast('Payment failed. Please try again.', true);
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = 'PAY NOW';
                }
                // If still pending, keep polling
            }, 3000);

        } catch (err) {
            console.error("Payment error:", err);
            showToast(err.message || 'Payment failed. Please try again.', true);
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'PAY NOW';
        }
    }

    // ===== SHOW ERROR =====
    function showError(message) {
        if (skeletonLoader) skeletonLoader.classList.remove('show');
        if (errorState) { errorState.style.display = 'flex'; if (errorMessage) errorMessage.textContent = message; }
        if (filmDetails) filmDetails.classList.remove('show');
    }

    function isValidUUID(uuid) {
        var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return uuidRegex.test(uuid);
    }

    // ===== INIT =====
    function init() {
        loadFilm();
        if (watchBtn) watchBtn.addEventListener('click', openPaymentSheet);
        if (followBtn) followBtn.addEventListener('click', toggleFollow);
        if (phoneInput) phoneInput.addEventListener('input', autoSelectNetwork);
    }

    window.openPaymentSheet = openPaymentSheet;
    window.closeModal = closeModal;
    window.selectMethod = selectMethod;
    window.confirmPayment = confirmPayment;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

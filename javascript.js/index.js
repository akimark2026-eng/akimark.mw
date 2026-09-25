// index.js (v2 — Cinema loader + fast path for logged-in users)

(function() {
    'use strict';

    // ================== CONFIG ==================
    var APP_VERSION = '1.0.0';  // Fallback if Android bridge not available
    var UPDATE_URL = 'https://akimark.mw';
    var UPDATE_PAGE = 'update.html';

    // Try to get version from Android bridge
    if (window.Android && window.Android.getAppVersion) {
        APP_VERSION = window.Android.getAppVersion();
    }

    var TOKEN_KEY = 'akmark_token';
    var SUPABASE_URL = window.SUPABASE_URL || 'https://jnqwvmxuieeelvukhcsq.supabase.co';
    var HOME_PAGE = 'home.html';
    var NON_PAGE = 'non.html';
    var BLOCKED_PAGE = 'blocked.html';
    var LOGIN_CHECKER_ENDPOINT = SUPABASE_URL + '/functions/v1/login-checker';
    var GET_CHALLENGE_ENDPOINT = SUPABASE_URL + '/functions/v1/security-api?action=get_challenge';
    var DEVICE_CHECK_ENDPOINT = SUPABASE_URL + '/functions/v1/security-api?action=verify_device';
    var ATTESTATION_TIMEOUT = 15000;

    // ================== RISK SCORE ==================
    function getAndroidRiskScore() {
        if (window.Android && typeof window.Android.getEmulatorRisk === 'function') {
            try {
                var score = parseInt(window.Android.getEmulatorRisk());
                return isNaN(score) ? 0 : score;
            } catch (e) { return 0; }
        }
        return 0;
    }

    function getBrowserRiskScore() {
        var score = 0;
        var ua = navigator.userAgent.toLowerCase();
        var emulatorKeywords = ['emulator', 'simulator', 'bluestacks', 'nox', 'ldplayer', 'mumu', 'memu', 'genymotion'];
        for (var i = 0; i < emulatorKeywords.length; i++) {
            if (ua.indexOf(emulatorKeywords[i]) !== -1) { score += 40; break; }
        }
        if (!('ontouchstart' in window) && !navigator.maxTouchPoints) score += 15;
        if (window.screen.width === 320 && window.screen.height === 240) score += 10;
        return score;
    }

    // ================== REDIRECT HELPERS ==================
    function goToBlocked() {
        window.location.href = BLOCKED_PAGE;
    }

    function goToUpdatePage(latestVersion, currentVersion) {
        var url = UPDATE_PAGE
            + '?latest=' + encodeURIComponent(latestVersion || '')
            + '&current=' + encodeURIComponent(currentVersion || 'unknown');
        window.location.href = url;
    }

    // ================== CLEAR SESSION ==================
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem('akmark_user');
    }

    // ================== VERSION CHECK ==================
    function checkVersion(data) {
        var latestVersion = data && data.latest_version ? data.latest_version : '';
        var forceUpdate = data && data.force_update === true;

        if (forceUpdate) {
            console.log('[Akimark] Force update required:', {
                current: APP_VERSION,
                latest: latestVersion,
            });
            goToUpdatePage(latestVersion, APP_VERSION);
            return false;
        }

        if (latestVersion && latestVersion !== APP_VERSION) {
            console.log('[Akimark] Version mismatch detected:', {
                current: APP_VERSION,
                latest: latestVersion,
            });
            goToUpdatePage(latestVersion, APP_VERSION);
            return false;
        }

        return true;
    }

    // ================== GLOBAL CALLBACK (from Android) ==================
    var attestationDone = false;

    window.onAttestationResult = function(valid, reason) {
        if (attestationDone) return;
        attestationDone = true;
        if (window._attestationTimeout) clearTimeout(window._attestationTimeout);

        if (valid) {
            checkLogin();
        } else {
            console.log('Attestation failed, falling back to device risk check');
            performDeviceCheck();
        }
    };

    // ================== DEVICE CHECK (FALLBACK) ==================
    function performDeviceCheck() {
        var riskScore = Math.max(getAndroidRiskScore(), getBrowserRiskScore());
        var token = localStorage.getItem(TOKEN_KEY) || '';

        fetch(DEVICE_CHECK_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                risk_score: riskScore,
                build: (window.Android && window.Android.getBuild) ? window.Android.getBuild() : '',
                model: (window.Android && window.Android.getModel) ? window.Android.getModel() : ''
            })
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            if (data.valid === true) {
                checkLogin();
            } else {
                goToBlocked();
            }
        })
        .catch(function() {
            window.location.href = NON_PAGE;
        });
    }

    // ================== CHECK LOGIN + VERSION ==================
    function checkLogin() {
        var token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            window.location.href = NON_PAGE;
            return;
        }

        fetch(LOGIN_CHECKER_ENDPOINT, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json',
                'x-app-version': APP_VERSION
            }
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            if (data.valid) {
                // Backend decides: force_update → update.html
                if (!checkVersion(data)) {
                    return;
                }
                // ✅ Valid user → HOME fast
                window.location.href = HOME_PAGE;
            } else {
                clearSession();
                window.location.href = NON_PAGE;
            }
        })
        .catch(function() {
            clearSession();
            window.location.href = NON_PAGE;
        });
    }

    // ================== PERFORM ATTESTATION ==================
    function performAttestation() {
        fetch(GET_CHALLENGE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(function(response) { return response.json(); })
        .then(function(data) {
            if (!data.challenge) {
                console.error('No challenge received');
                performDeviceCheck();
                return;
            }
            var challenge = data.challenge;
            window._attestationTimeout = setTimeout(function() {
                if (!attestationDone) {
                    attestationDone = true;
                    window.onAttestationResult(false, 'timeout');
                }
            }, ATTESTATION_TIMEOUT);

            if (window.Android && typeof window.Android.requestAttestation === 'function') {
                window.Android.requestAttestation(challenge, '');
            } else {
                window.onAttestationResult(false, 'No Android bridge');
            }
        })
        .catch(function() { performDeviceCheck(); });
    }

    // ================== INIT ==================
    // 🆕 FAST PATH: If user has a token, skip attestation entirely
    //    and go straight to login-checker → HOME (very fast).
    //    Guests (no token) go through normal attestation flow → NON.
    function init() {
        var combinedRisk = Math.max(getAndroidRiskScore(), getBrowserRiskScore());
        if (combinedRisk >= 90) {
            goToBlocked();
            return;
        }

        // 🚀 FAST PATH for logged-in users
        var token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            console.log('[Akimark] Token found — fast path to home');
            checkLogin();
            return;
        }

        // Normal flow for guests → attestation → non.html
        performAttestation();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

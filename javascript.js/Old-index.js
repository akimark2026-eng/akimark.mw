(function() {
    'use strict';

    // ================== CONFIG ==================
    var APP_VERSION = '1.0.0';  // Fallback if Android bridge not available
    var UPDATE_URL = 'https://akimark.mw'; // <-- URL YA UPDATE

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

    // ================== REDIRECT TO BLOCKED PAGE ==================
    function goToBlocked() {
        window.location.href = BLOCKED_PAGE;
    }

    // ================== CLEAR SESSION ==================
    function clearSession() {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem('akmark_refresh_token');
        localStorage.removeItem('akmark_user');
    }

    // ================== VERSION CHECK + MODAL (UPGRADED) ==================
    function showUpdateModal() {
        if (document.getElementById('updateModal')) return;
        var modal = document.createElement('div');
        modal.id = 'updateModal';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);z-index:999999;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `
            <div style="background:linear-gradient(145deg,#1a1a2e,#16213e,#0f3460);border-radius:20px;padding:30px;text-align:center;color:#fff;max-width:400px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.6);border:2px solid #c71515;">
                <div style="font-size:4rem;margin-bottom:15px;">😋</div>
                <h2 style="color:#c71515;margin-bottom:10px;font-weight:800;">WE ARE BETTER THAN EVER</h2>
                <p style="color:#ddd;margin-bottom:20px;font-size:16px;">PLEASE UPDATE NOW!</p>
                <p style="color:#aaa;margin-bottom:25px;font-size:14px;">You are using an outdated version. Please update to continue.</p>
                <button onclick="window.location.href='${UPDATE_URL}'" style="background:#c71515;color:#fff;border:none;padding:14px 30px;border-radius:30px;font-size:16px;font-weight:bold;cursor:pointer;box-shadow:0 5px 15px rgba(199,21,21,0.5);">
                     DOWNLOAD NOW
                </button>
                <p id="countdown" style="color:#888;margin-top:15px;font-size:14px;"></p>
            </div>
        `;
        document.body.appendChild(modal);
        // Auto-redirect countdown – high-end force update
        var seconds = 5;
        var countdownEl = modal.querySelector('#countdown');
        countdownEl.textContent = 'Redirecting to download in ' + seconds + ' seconds...';
        var interval = setInterval(function() {
            seconds--;
            if (seconds <= 0) {
                clearInterval(interval);
                window.location.href = UPDATE_URL;
            } else {
                countdownEl.textContent = 'Redirecting to download in ' + seconds + ' seconds...';
            }
        }, 1000);
    }

    function checkVersion(latestVersion) {
        if (latestVersion && latestVersion !== APP_VERSION) {
            // High-end detection: any mismatch triggers forced update flow
            showUpdateModal();
            // If modal already shown, it will handle redirect after countdown
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
            console.log("Attestation failed, falling back to device risk check");
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
        .then(response => response.json())
        .then(data => {
            if (data.valid === true) {
                checkLogin();
            } else {
                goToBlocked();
            }
        })
        .catch(() => {
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
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        })
        .then(response => response.json())
        .then(data => {
            if (data.valid) {
                if (!checkVersion(data.latest_version)) {
                    return;
                }
                window.location.href = HOME_PAGE;
            } else {
                clearSession();
                window.location.href = NON_PAGE;
            }
        })
        .catch(() => {
            clearSession();
            window.location.href = NON_PAGE;
        });
    }

    // ================== PERFORM ATTESTATION ==================
    function performAttestation() {
        fetch(GET_CHALLENGE_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(response => response.json())
        .then(data => {
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
        .catch(() => performDeviceCheck());
    }

    // ================== INIT ==================
    function init() {
        var combinedRisk = Math.max(getAndroidRiskScore(), getBrowserRiskScore());
        if (combinedRisk >= 90) {
            goToBlocked();
            return;
        }
        performAttestation();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

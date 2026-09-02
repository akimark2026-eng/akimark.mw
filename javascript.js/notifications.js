// notifications.js
(function() {
    'use strict';

    var SUPABASE_URL = window.SUPABASE_URL;
    var token = localStorage.getItem('akmark_token');

    var notifList = document.getElementById('notifList');
    var emptyState = document.getElementById('emptyState');
    var clearBtn = document.getElementById('clearAllBtn');
    var toast = document.getElementById('toast');

    function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(function() { toast.classList.remove('show'); }, 3000);
    }

    function formatTime(dateString) {
        var date = new Date(dateString);
        var now = new Date();
        var diff = Math.floor((now - date) / 1000);

        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
        if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
        return date.toLocaleDateString();
    }

    function renderNotif(notif) {
        var item = document.createElement('div');
        item.className = 'notif-item' + (notif.is_read ? '' : ' unread');
        item.dataset.id = notif.id;

        var iconSvg = '';
        if (notif.type === 'new_film') {
            iconSvg = '<svg viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-4l2 4H10L8 4H4v6h20V4h-6zm-2 8h-8v6h8v-6z"/></svg>';
        } else if (notif.type === 'latest') {
            iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 16l-6-6 1.41-1.41L11 14.17V6h2v8.17l3.59-3.58L18 12l-6 6z"/></svg>';
        } else {
            iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
        }

        item.innerHTML = `
            <div class="notif-icon">${iconSvg}</div>
            <div class="notif-content">
                <div class="notif-title">${notif.title}</div>
                <div class="notif-message">${notif.message || ''}</div>
                <div class="notif-time">${formatTime(notif.created_at)}</div>
            </div>
        `;

        // Mark as read on click
        item.addEventListener('click', function() {
            if (item.classList.contains('unread')) {
                // Update local UI
                item.classList.remove('unread');
                // Send to backend (optional)
                fetch(`${SUPABASE_URL}/functions/v1/notifications-api?action=mark_read`, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ id: notif.id })
                });
            }
        });

        notifList.appendChild(item);
    }

    async function loadNotifications() {
        try {
            var res = await fetch(`${SUPABASE_URL}/functions/v1/notifications-api?action=list`, {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to load');

            if (!data.notifications || data.notifications.length === 0) {
                notifList.innerHTML = '';
                emptyState.style.display = 'flex';
                return;
            }
            emptyState.style.display = 'none';
            notifList.innerHTML = '';
            data.notifications.forEach(renderNotif);
        } catch (err) {
            console.error('Error loading notifications:', err);
            showToast('Failed to load notifications');
            emptyState.style.display = 'flex';
        }
    }

    async function clearAll() {
        try {
            var res = await fetch(`${SUPABASE_URL}/functions/v1/notifications-api?action=clear_all`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            var data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to clear');
            notifList.innerHTML = '';
            emptyState.style.display = 'flex';
            showToast('All notifications cleared');
        } catch (err) {
            console.error('Error clearing:', err);
            showToast('Failed to clear');
        }
    }

    clearBtn.addEventListener('click', clearAll);

    loadNotifications();
})();

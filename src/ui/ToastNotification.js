// @ts-check

class ToastNotification {
    constructor() {
        this.container = document.getElementById('toast-container');
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = 'toast-container';
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        }
        this.toasts = new Map();
    }

    /**
     * Show a toast notification
     * @param {string} message - Main message to display
     * @param {string} type - Type of notification: 'success', 'error', 'warning', 'info'
     * @param {string} title - Optional title for the notification
     * @param {number} duration - Duration in milliseconds (0 for persistent)
     */
    show(message, type = 'info', title = '', duration = 5000) {
        const id = Date.now() + Math.random();
        const toast = this.createToast(id, message, type, title);

        this.container.appendChild(toast);
        this.toasts.set(id, toast);

        // Auto-dismiss if duration is set
        if (duration > 0) {
            setTimeout(() => this.dismiss(id), duration);
        }

        return id;
    }

    /**
     * Create toast element
     */
    createToast(id, message, type, title) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.dataset.toastId = String(id);

        const icon = this.getIcon(type);
        const toastTitle = title || this.getDefaultTitle(type);

        toast.innerHTML = `
            <div class="toast-icon">${icon}</div>
            <div class="toast-content">
                <div class="toast-title">${this.escapeHtml(toastTitle)}</div>
                <div class="toast-message">${this.escapeHtml(message)}</div>
            </div>
            <button class="toast-close" aria-label="Close">&times;</button>
        `;

        // Add close button handler
        const closeBtn = toast.querySelector('.toast-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.dismiss(id));
        }

        return toast;
    }

    /**
     * Dismiss a toast notification
     */
    dismiss(id) {
        const toast = this.toasts.get(id);
        if (!toast) return;

        toast.classList.add('toast-exit');
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
            this.toasts.delete(id);
        }, 300); // Match animation duration
    }

    /**
     * Get icon for toast type
     */
    getIcon(type) {
        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️'
        };
        return icons[type] || icons.info;
    }

    /**
     * Get default title for toast type
     */
    getDefaultTitle(type) {
        const titles = {
            success: 'Success',
            error: 'Error',
            warning: 'Warning',
            info: 'Info'
        };
        return titles[type] || titles.info;
    }

    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Convenience methods
    success(message, title = '', duration = 5000) {
        return this.show(message, 'success', title, duration);
    }

    error(message, title = '', duration = 7000) {
        return this.show(message, 'error', title, duration);
    }

    warning(message, title = '', duration = 6000) {
        return this.show(message, 'warning', title, duration);
    }

    info(message, title = '', duration = 5000) {
        return this.show(message, 'info', title, duration);
    }

    /**
     * Dismiss all toasts
     */
    dismissAll() {
        this.toasts.forEach((_toast, id) => this.dismiss(id));
    }
}


export default ToastNotification;

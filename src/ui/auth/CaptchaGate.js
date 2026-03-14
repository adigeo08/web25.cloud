// @ts-check

function randomToken(length = 5) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let output = '';
    for (let i = 0; i < length; i += 1) {
        output += chars[Math.floor(Math.random() * chars.length)];
    }
    return output;
}

export function bindCaptchaGate(onSolved) {
    const input = /** @type {HTMLInputElement | null} */ (document.getElementById('captcha-input'));
    const challenge = document.getElementById('captcha-challenge');
    const verifyButton = document.getElementById('captcha-verify-btn');
    const refreshButton = document.getElementById('captcha-refresh-btn');
    const status = document.getElementById('captcha-status');
    const gate = document.getElementById('captcha-gate');

    if (!input || !challenge || !verifyButton || !status || !gate) return;

    let current = randomToken();

    const repaint = () => {
        current = randomToken();
        challenge.textContent = current;
        input.value = '';
        status.textContent = 'Complete captcha to unlock wallet actions.';
    };

    repaint();

    verifyButton.addEventListener('click', () => {
        const value = input.value.trim().toUpperCase();
        if (!value || value !== current) {
            status.textContent = 'Captcha invalid. Please try again.';
            repaint();
            return;
        }

        gate.classList.add('hidden');
        status.textContent = 'Captcha verified.';
        onSolved();
    });

    refreshButton?.addEventListener('click', repaint);
}

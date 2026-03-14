// @ts-check

export function renderPublishReview(payload) {
    const pre = document.getElementById('publish-payload-preview');
    if (!pre) return;

    pre.textContent = payload ? JSON.stringify(payload, null, 2) : 'No payload signed yet.';
}

// @ts-check

export function bindPublishActions({ onSign, onPublish }) {
    const signBtn = document.getElementById('sign-publish-btn');
    const publishBtn = document.getElementById('publish-btn');

    if (signBtn) signBtn.addEventListener('click', onSign);
    if (publishBtn) publishBtn.addEventListener('click', onPublish);
}

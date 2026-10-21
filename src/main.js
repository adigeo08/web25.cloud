// @ts-check
import PeerWeb from './core/PeerWeb.js';
import { installGoFileAboutCopy } from './ui/AboutGoFile.js';
import { installAboutChapters } from './ui/about/AboutChapters.js';

document.addEventListener('DOMContentLoaded', () => {
    installAboutChapters();
    installGoFileAboutCopy();
    window.peerWeb = new PeerWeb();
});

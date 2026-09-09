// @ts-check
import PeerWeb from './core/PeerWeb.js';
import { installGoFileAboutCopy } from './ui/AboutGoFile.js';

document.addEventListener('DOMContentLoaded', () => {
    installGoFileAboutCopy();
    window.peerWeb = new PeerWeb();
});

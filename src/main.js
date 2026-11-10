// @ts-check
import PeerWeb from './core/PeerWeb.js';
import { installGoFileAboutCopy } from './ui/AboutGoFile.js';
import { installAboutChapters } from './ui/about/AboutChapters.js';
import { installTechDialogs } from './ui/about/TechDialog.js';
import { installWebLLMTab } from './webllm/WebLLMTab.js';

document.addEventListener('DOMContentLoaded', () => {
    installAboutChapters();
    installTechDialogs();
    installGoFileAboutCopy();
    installWebLLMTab();
    window.peerWeb = new PeerWeb();
});

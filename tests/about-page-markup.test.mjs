/**
 * About page contracts that live in index.html and styles.css.
 *
 * Covers the local-first parallax message, the clickable chapter index, and the
 * stylesheet rules behind anchor navigation (sticky offset, smooth scrolling,
 * reduced motion) and behind the layout that must not change (sticky rail,
 * stacked phone layout, the `.about-card > …` direct-child rules).
 *
 * Geometry — that the page really lays out the same, and that links really
 * land below the sticky strip — is measured in a browser by
 * about-page-browser.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MARKUP = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

const flat = (text) => text.replace(/\s+/g, ' ').trim();

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(STYLES);
    assert.ok(match, `${selector} rule exists`);
    return flat(match[1]);
}

/** The body of the `@media` block that starts with `query`, braces balanced. */
function mediaBlock(query, from = 0) {
    const start = STYLES.indexOf(`@media ${query} {`, from);
    assert.ok(start >= 0, `@media ${query} exists`);
    let depth = 0;
    for (let i = STYLES.indexOf('{', start); i < STYLES.length; i += 1) {
        if (STYLES[i] === '{') depth += 1;
        if (STYLES[i] === '}' && --depth === 0) return STYLES.slice(STYLES.indexOf('{', start) + 1, i);
    }
    throw new Error(`unterminated @media ${query}`);
}

// ── parallax message ────────────────────────────────────────────────────────

const PARALLAX = MARKUP.slice(MARKUP.indexOf('<div class="lp-parallax">'), MARKUP.indexOf('<!-- Sticky showcase'));

test('the parallax band carries the local-first message in the existing structure', () => {
    assert.match(PARALLAX, /<div class="lp-parallax">\s*<div class="lp-parallax-inner">/);
    assert.match(PARALLAX, /<p class="lp-quote">Local-first by design\. Peer-to-peer by default\.<\/p>/);
    assert.match(PARALLAX, /<p class="lp-quote-sub">/);
    assert.equal(PARALLAX.match(/<p class="lp-quote/g).length, 2, 'still one title and one description');

    const description = flat(/<p class="lp-quote-sub">([\s\S]*?)<\/p>/.exec(PARALLAX)[1]);
    assert.equal(
        description,
        'WEB25.cloud keeps identities and data local, with WebRTC as the preferred direct transport. ' +
            'Public WebTorrent trackers, STUN servers, Nostr relays and edge services like GoFile are ' +
            'replaceable building blocks for discovery, connectivity and fallback — ' +
            'never dependencies on a single provider.'
    );
});

test('the old consent quote is gone from the band, and the message stays honest about what each service does', () => {
    assert.doesNotMatch(PARALLAX, /Cryptographic validity is not consent/);
    assert.doesNotMatch(MARKUP, /“Cryptographic validity is not consent\.”/);

    const description = flat(/<p class="lp-quote-sub">([\s\S]*?)<\/p>/.exec(PARALLAX)[1]);
    // Modular, replaceable infrastructure — not a claim that all of it is decentralized…
    assert.match(description, /replaceable building blocks/);
    assert.doesNotMatch(description, /decentrali[sz]ed|trustless|serverless/i);
    // …and WebRTC is the transport. STUN only helps two peers find a route.
    const stunSentence = description.split('. ').find((sentence) => sentence.includes('STUN'));
    assert.doesNotMatch(stunSentence, /transport|carr(y|ies)|relay(s|ed) (messages|data)/i);
    assert.match(description, /WebRTC as the preferred direct transport/);
});

// ── chapter index ───────────────────────────────────────────────────────────

const RAIL_START = MARKUP.indexOf('<aside class="lp-showcase-rail">');
const RAIL = MARKUP.slice(RAIL_START, MARKUP.indexOf('</aside>', RAIL_START));

test('the chapter index is the same numbered list, now made of anchor links', () => {
    const items = [...RAIL.matchAll(/<li><a href="(#about-[a-z]+)">([^<]+)<\/a><\/li>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(items, [
        ['#about-identity', 'Identity'],
        ['#about-publishing', 'Publishing'],
        ['#about-messenger', 'Direct Messenger'],
        ['#about-consent', 'Consent'],
        ['#about-nostr', 'Nostr relay'],
        ['#about-security', 'Security profile']
    ]);
    // Still an <ol class="lp-showcase-index"> — the counter numbering hangs off it.
    assert.match(RAIL, /<ol class="lp-showcase-index">/);
    assert.equal(RAIL.match(/<li>/g).length, 6);
    assert.match(RAIL, /<nav aria-label="Deep dive chapters">\s*<ol/);
});

test('every index link points at a chapter article, in the same order', () => {
    const hrefs = [...RAIL.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    const ids = [...MARKUP.matchAll(/<article class="about-card lp-reveal" id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, hrefs);
    assert.equal(new Set(MARKUP.match(/\sid="[^"]+"/g)).size, MARKUP.match(/\sid="[^"]+"/g).length, 'ids are unique');
});

test('the rail keeps its kicker, heading and intro above the list', () => {
    assert.match(RAIL, /<span class="section-kicker">Deep dive<\/span>\s*<h4>Six things worth knowing<\/h4>\s*<p>/);
});

// ── anchor navigation styles ────────────────────────────────────────────────

test('chapter cards stop below the sticky tab strip', () => {
    // The strip is pinned at the top of the page…
    assert.match(rule('.tab-nav'), /position: sticky; top: 0;/);
    // …the rail already clears it by --showcase-top, and a card scrolled to uses the same distance.
    assert.match(rule('.lp-showcase'), /--showcase-top: 5rem;/);
    assert.match(rule('.lp-showcase-rail'), /position: sticky; top: var\(--showcase-top\);/);
    assert.match(rule('.lp-showcase-cards > .about-card'), /scroll-margin-top: var\(--showcase-top\);/);
});

test('on a phone, where the strip is collapsed behind the burger, the margin shrinks', () => {
    const phone = mediaBlock('(max-width: 720px)', STYLES.indexOf('.lp-showcase-cards > .about-card'));
    assert.match(flat(phone), /\.lp-showcase-cards > \.about-card \{ scroll-margin-top: 1rem; \}/);
    // The justification: at that width the tab list is not displayed (and so not pinned) until opened.
    assert.match(flat(mediaBlock('(max-width: 720px)')), /\.tab-nav \{ display: none;/);
});

test('smooth scrolling is on only when the visitor has not asked for less motion', () => {
    const smooth = [...STYLES.matchAll(/scroll-behavior: smooth/g)].map((m) => m.index);
    assert.ok(smooth.length > 0, 'smooth scrolling is declared');
    for (const index of smooth) {
        const media = STYLES.lastIndexOf('@media', index);
        assert.ok(
            STYLES.startsWith('@media (prefers-reduced-motion: no-preference) {', media),
            'every smooth declaration sits inside prefers-reduced-motion: no-preference'
        );
    }
    assert.match(
        flat(mediaBlock('(prefers-reduced-motion: no-preference)', STYLES.indexOf('--showcase-top: 5rem'))),
        /html:has\(#tab-about\.active\) \{ scroll-behavior: smooth; \}/
    );
});

test('reduced motion still forces instant scrolling and no animation anywhere', () => {
    const reduced = flat(mediaBlock('(prefers-reduced-motion: reduce)'));
    assert.match(reduced, /scroll-behavior: auto !important;/);
    assert.match(reduced, /animation-duration: 0\.01ms !important;/);
});

test('index links keep the row look, are keyboard reachable and show focus', () => {
    const link = rule('.lp-showcase-index a');
    assert.match(link, /color: inherit;/);
    assert.match(link, /margin: -0\.4rem 0; padding: 0\.4rem 0;/, 'link fills the row without changing its height');
    assert.match(rule('.lp-showcase-index a:hover,\n.lp-showcase-index a:focus-visible'), /text-decoration: none;/);

    // Focus ring: the global one applies, and nothing here switches it off.
    assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\);/);
    assert.doesNotMatch(
        STYLES.slice(STYLES.indexOf('.lp-showcase-index a')),
        /\.lp-showcase-index[^{]*\{[^}]*outline: (none|0)/
    );

    // Numbering is unchanged.
    assert.match(rule('.lp-showcase-index li::before'), /content: counter\(showcase, decimal-leading-zero\);/);
    assert.match(rule('.lp-showcase-index'), /counter-reset: showcase;/);
});

// ── layout that must not change ─────────────────────────────────────────────

test('desktop layout: sticky rail on the left, cards stacked on the right', () => {
    assert.match(rule('.lp-showcase'), /grid-template-columns: minmax\(0, 0\.8fr\) minmax\(0, 1\.6fr\);/);
    assert.match(rule('.lp-showcase'), /align-items: start;/);
    assert.match(rule('.lp-showcase-rail'), /position: sticky;/);
    assert.match(rule('.lp-showcase-cards'), /display: grid; gap: 0\.85rem;/);
});

test('narrow layout: one column, rail above the cards and no longer sticky', () => {
    const narrow = flat(mediaBlock('(max-width: 1000px)'));
    assert.match(narrow, /\.lp-showcase \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    assert.match(narrow, /\.lp-showcase-rail \{ position: static; \}/);
});

test('the card styles that reach direct children are untouched', () => {
    assert.match(rule('.about-card > h3'), /margin: 0 0 0\.6rem; font-size: 1\.02rem;/);
    assert.match(rule('.about-card > h4'), /margin: 0\.4rem 0 0\.5rem;/);
    assert.match(rule('.about-card > p'), /margin: 0 0 0\.75rem; font-size: 0\.88rem;/);
    assert.match(rule('.about-card > .feature-grid'), /grid-template-columns: 1fr;/);
    assert.match(rule('.about-card > .feature-grid .feature'), /padding: 0\.55rem 0\.7rem; font-size: 0\.81rem;/);
    assert.match(rule('.about-card > :last-child'), /margin-bottom: 0;/);
});

test('the scroll reveal animation still drives .lp-reveal where supported', () => {
    assert.match(
        STYLES,
        /@supports \(animation-timeline: view\(\)\) \{\s*@media \(prefers-reduced-motion: no-preference\) \{\s*\.lp-reveal \{/
    );
    assert.match(STYLES, /animation-range: entry 0% entry 100%;/);
});

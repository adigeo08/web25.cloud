import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
let chromium;
try {
    ({ chromium } = await import(process.env.WEB25_PLAYWRIGHT_MODULE || 'playwright'));
} catch {}
test(
    'project UI subscribes, unsubscribes, routes updates and hides unverified projects',
    { skip: !chromium },
    async () => {
        const server = http.createServer((req, res) => {
            if (req.url === '/') {
                res.setHeader('Content-Type', 'text/html');
                res.end(
                    '<select id="deploy-project"><option value="">No subscriptions</option><option value="new">Create new subscribable project</option></select><section id="project-conversations"></section><button id="viewer-project-subscribe" hidden></button>'
                );
                return;
            }
            const file = path.join(process.cwd(), decodeURIComponent(req.url));
            res.setHeader('Content-Type', 'text/javascript');
            try {
                res.end(fs.readFileSync(file));
            } catch {
                res.statusCode = 404;
                res.end();
            }
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const browser = await chromium.launch({
            ...(fs.existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}),
            headless: true,
            args: ['--no-sandbox']
        });
        try {
            const page = await browser.newPage();
            await page.goto(`http://127.0.0.1:${server.address().port}`);
            const result = await page.evaluate(async () => {
                const { mountProjectRooms } = await import('/src/ui/ProjectRooms.js');
                const p = {
                    id: 'a'.repeat(64),
                    roomId: 'prj-' + 'b'.repeat(32),
                    name: 'Alice',
                    history: [{ version: 1 }],
                    subscribers: {},
                    deliveries: {}
                };
                const manifest = { payload: { project: p } };
                const state = { owned: { [p.id]: p }, followed: {} };
                let calls = [];
                const service = {
                    inspect: async () => structuredClone(state),
                    follow: async (m, active) => {
                        calls.push(active);
                        state.followed[p.id] = {
                            ...p,
                            manifest: m,
                            active,
                            status: active ? 'subscribed' : 'unsubscribed',
                            version: 2,
                            updates: [
                                {
                                    version: 2,
                                    publishedAt: '2026-11-12T00:00:00Z',
                                    infoHash: 'c'.repeat(40),
                                    magnetURI: 'magnet:?xt=urn:btih:' + 'c'.repeat(40),
                                    mirrorURL: 'https://example.com/update'
                                }
                            ]
                        };
                    },
                    retry: async () => {},
                    removeSubscriber: async () => {}
                };
                mountProjectRooms(service, { started: true, start: async () => {} }, (e) => {
                    throw e;
                });
                const pause = () => new Promise((r) => setTimeout(r, 30));
                window.dispatchEvent(new CustomEvent('web25-project-view', { detail: manifest }));
                await pause();
                const button = document.getElementById('viewer-project-subscribe');
                if (button.hidden) throw Error('Verified project subscription hidden');
                button.click();
                await pause();
                if (!button.textContent.startsWith('Subscribed')) throw Error('Subscription not reflected');
                if (
                    document.querySelector('#project-conversations a').getAttribute('href') !==
                    '?orc=' + 'c'.repeat(40)
                )
                    throw Error('Wrong update URL');
                if (![...document.getElementById('deploy-project').options].some((o) => o.value === p.id))
                    throw Error('Project reuse unavailable');
                button.click();
                await pause();
                if (calls.join(',') !== 'true,false') throw Error('Unsubscribe not sent');
                window.dispatchEvent(new CustomEvent('web25-project-view', { detail: null }));
                if (!button.hidden) throw Error('Unverified project subscription visible');
                service.onLocked();
                if (document.getElementById('project-conversations').children.length)
                    throw Error('Private subscriber UI retained on lock');
                return 'Project browser controls passed';
            });
            console.log(result);
        } finally {
            await browser.close();
            server.close();
        }
    }
);

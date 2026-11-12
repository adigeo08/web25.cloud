// @ts-check
// Small native controls, kept outside the deploy lifecycle and ordinary DM rendering.
export function mountProjectRooms(service, session, report = console.error) {
    if (typeof document === 'undefined' || !document.createElement) return;
    const select = document.getElementById('deploy-project');
    const panel = document.getElementById('project-conversations');
    const button = document.getElementById('viewer-project-subscribe');
    let viewed = null;
    let refreshing = false;
    const act = (fn) => async () => {
        try {
            await session.start();
            await fn();
            await refresh();
        } catch (e) {
            report(e);
        }
    };
    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        try {
            const state = await service.inspect();
            if (!session.started) return;
            if (select) {
                const selected = select.value;
                select.replaceChildren(
                    new Option('No subscriptions', ''),
                    new Option('Create new subscribable project', 'new')
                );
                for (const p of Object.values(state.owned)) {
                    select.add(new Option(`${p.name} · ${p.roomId} · v${p.history.at(-1)?.version || 0}`, p.id));
                }
                select.value = selected;
            }
            if (button && viewed) {
                const p = state.followed[viewed.payload.project.id];
                button.textContent = p?.active
                    ? `${p.status === 'subscribed' ? 'Subscribed' : 'Subscription pending'} · Unsubscribe`
                    : 'Subscribe';
            }
            if (panel) {
                panel.replaceChildren();
                for (const p of Object.values(state.followed)) {
                    const conversation = document.createElement('details');
                    const title = document.createElement('summary');
                    title.textContent = `${p.roomId} · v${p.version} · ${p.status}`;
                    conversation.append(title);
                    const unsubscribe = document.createElement('button');
                    unsubscribe.textContent = p.active ? 'Unsubscribe' : 'Subscribe';
                    unsubscribe.onclick = act(() => service.follow(p.manifest, !p.active));
                    conversation.append(unsubscribe);
                    if (p.pendingMessage) {
                        const retry = document.createElement('button');
                        retry.textContent = 'Retry subscription request';
                        retry.onclick = act(() => service.retryRequest(p.id));
                        conversation.append(retry);
                    }
                    for (const update of p.updates) {
                        const row = document.createElement('p');
                        row.textContent = `Version ${update.version} · ${update.publishedAt} · Content verification required `;
                        const link = document.createElement('a');
                        link.textContent = 'Open deployment';
                        link.href = `?orc=${update.infoHash}`;
                        row.append(link);
                        if (update.magnetURI) {
                            const a = document.createElement('a');
                            a.href = update.magnetURI;
                            a.textContent = ' Magnet';
                            row.append(a);
                        }
                        if (update.mirrorURL) {
                            const a = document.createElement('a');
                            a.href = update.mirrorURL;
                            a.textContent = ' Mirror';
                            a.rel = 'noopener noreferrer';
                            row.append(a);
                        }
                        conversation.append(row);
                    }
                    panel.append(conversation);
                }
                for (const p of Object.values(state.owned)) {
                    const group = document.createElement('details');
                    const title = document.createElement('summary');
                    title.textContent = `${p.name} · ${p.roomId} · publisher subscribers`;
                    group.append(title);
                    for (const [peer, subscriber] of Object.entries(p.subscribers)) {
                        if (subscriber.active) {
                            const remove = document.createElement('button');
                            remove.textContent = `Remove ${peer}`;
                            remove.onclick = act(() => service.removeSubscriber(p.id, peer));
                            group.append(remove);
                        }
                    }
                    const retry = document.createElement('button');
                    retry.textContent = 'Retry failed notifications';
                    retry.onclick = act(() => service.retry(p.id));
                    group.append(retry);
                    const status = document.createElement('p');
                    status.textContent =
                        Object.values(p.deliveries)
                            .map((d) => `${d.update.version}: ${d.state}`)
                            .join(', ') || 'No notifications';
                    group.append(status);
                    panel.append(group);
                }
            }
        } finally {
            refreshing = false;
        }
    }
    service.onLocked = () => {
        if (panel) panel.replaceChildren();
        if (select)
            {select.replaceChildren(
                new Option('No subscriptions', ''),
                new Option('Create new subscribable project', 'new')
            );}
        if (button && viewed) button.textContent = 'Subscribe (Nostr identity required)';
    };
    service.onChange = () => void refresh().catch(report);
    if (select) select.onfocus = () => void refresh().catch(report);
    if (button) {
        button.onclick = act(async () => {
            if (!viewed) return;
            const state = await service.inspect();
            if (!session.started) return;
            await service.follow(viewed, !state.followed[viewed.payload.project.id]?.active);
        });
        window.addEventListener('web25-project-view', (event) => {
            viewed = event.detail;
            button.hidden = !viewed?.payload?.project;
            button.textContent = 'Subscribe (Nostr identity required)';
            if (viewed) void refresh().catch(() => {});
        });
    }
    // Refresh after the wallet unlocks without starting a second inbox or requiring presence.
    const timer = setInterval(() => {
        if (session.started) void refresh().catch(() => {});
    }, 5000);
    timer.unref?.();
}

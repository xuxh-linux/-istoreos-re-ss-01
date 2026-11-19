'use strict';
'require view';
'require poll';
'require ui';
'require devmon.common as dm';

const STATE_RANK = { online: 0, idle: 1, offline: 2 };

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return dm.getStats();
	},

	stateBadge(dev) {
		const label = { online: _('Online'), idle: _('Idle'), offline: _('Offline') }[dev.state] || dev.state;
		const color = { online: '#1baf7a', idle: '#a0a0a0', offline: '#d0d0d0' }[dev.state] || '#d0d0d0';
		const nodes = [
			E('span', { style: 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:' + color }),
			label
		];
		if (dev.blocked)
			nodes.push(E('div', { style: 'color:#d03b3b;font-weight:bold' }, '⛔ ' + _('Blocked')));
		return E('span', { style: 'white-space:nowrap' }, nodes);
	},

	handleEdit(dev) {
		const name = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': dev.name || '', 'placeholder': dev.hostname || dev.mac, 'maxlength': 64 });
		const blocked = E('input', { 'type': 'checkbox', 'checked': dev.blocked ? '' : null });

		ui.showModal(_('Edit device') + ' ' + dev.mac, [
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Name')),
				E('div', { 'class': 'cbi-value-field' }, name)
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, _('Block internet access')),
				E('div', { 'class': 'cbi-value-field' }, [ blocked, ' ', E('span', { 'class': 'cbi-value-description' }, _('Drops forwarded traffic of this device; LAN access to the router itself is kept.')) ])
			]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')), ' ',
				E('button', {
					'class': 'btn cbi-button-positive',
					'click': ui.createHandlerFn(this, () => this.saveDevice(dev.mac, name.value, blocked.checked))
				}, _('Save'))
			])
		]);
	},

	saveDevice(mac, name, blocked) {
		return dm.setDevice(mac, name, blocked).then((res) => {
			ui.hideModal();
			if (res.error)
				ui.addNotification(null, E('p', _('Failed to save: %s').format(res.error)), 'error');
			return dm.getStats().then((st) => this.update(st));
		});
	},

	handleToggleBlock(dev) {
		if (!dev.blocked && !confirm(_('Block internet access of %s?').format(dm.displayName(dev))))
			return;
		return this.saveDevice(dev.mac, dev.name, !dev.blocked);
	},

	handleChart(dev) {
		const chart = new dm.RateChart();
		const refresh = () => dm.getHistory(dev.mac).then((h) => chart.update(h.ts, h.series.tx, h.series.rx));

		ui.showModal(_('Realtime traffic') + ': ' + dm.displayName(dev), [
			E('div', { 'style': 'min-width:min(720px,80vw)' }, chart.node),
			E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
		]);

		// 弹窗关闭后图表节点被移出文档，借此停掉定时刷新
		const timer = setInterval(() => {
			if (!document.body.contains(chart.node))
				clearInterval(timer);
			else
				refresh();
		}, (this.stats.interval || 2) * 1000);

		return refresh();
	},

	matches(dev, q) {
		if (!q)
			return true;
		q = q.toLowerCase();
		return [ dev.name, dev.hostname, dev.mac, ...(dev.ip4 || []), ...(dev.ip6 || []) ]
			.some((s) => s && String(s).toLowerCase().indexOf(q) >= 0);
	},

	renderSummary(st) {
		const devs = st.devices || [];
		const item = (label, value) => E('div', { 'style': 'min-width:110px' }, [
			E('div', { 'style': 'font-size:12px;opacity:.7' }, label),
			E('div', { 'style': 'font-size:20px;font-weight:600' }, value)
		]);

		this.summary.replaceChildren(
			item(_('Online'), '%d / %d'.format(devs.filter((d) => d.state == 'online').length, devs.length)),
			item(_('Upload'), dm.fmtRate(st.total?.tx_rate)),
			item(_('Download'), dm.fmtRate(st.total?.rx_rate)),
			item(_('Blocked'), String(devs.filter((d) => d.blocked).length))
		);
	},

	renderTable() {
		const st = this.stats;
		const q = this.search.value.trim();
		const hideOffline = this.hideOffline.checked;

		const devs = (st.devices || [])
			.filter((d) => this.matches(d, q) && !(hideOffline && d.state == 'offline'))
			.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) ||
				((b.tx_rate + b.rx_rate) - (a.tx_rate + a.rx_rate)) ||
				((b.tx_bytes + b.rx_bytes) - (a.tx_bytes + a.rx_bytes)) ||
				dm.displayName(a).localeCompare(dm.displayName(b)));

		const rows = devs.map((d) => [
			this.stateBadge(d),
			E('div', {}, [
				E('strong', {}, dm.displayName(d)),
				(d.name && d.hostname) ? E('div', { 'style': 'font-size:12px;opacity:.7' }, d.hostname) : ''
			]),
			E('div', { 'style': 'font-size:12px' }, [ ...(d.ip4 || []), ...(d.ip6 || []) ].map((ip) => E('div', {}, ip))),
			E('code', {}, d.mac),
			E('span', { 'style': 'white-space:nowrap' }, '↑ ' + dm.fmtRate(d.tx_rate)),
			E('span', { 'style': 'white-space:nowrap' }, '↓ ' + dm.fmtRate(d.rx_rate)),
			E('div', { 'style': 'font-size:12px;white-space:nowrap' }, [
				E('div', {}, '↑ ' + dm.fmtBytes(d.tx_bytes)),
				E('div', {}, '↓ ' + dm.fmtBytes(d.rx_bytes))
			]),
			E('div', { 'style': 'white-space:nowrap' }, [
				E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'handleChart', d), 'disabled': d.state == 'offline' && !d.tx_bytes ? '' : null }, _('Chart')), ' ',
				E('button', { 'class': 'btn cbi-button-edit', 'click': ui.createHandlerFn(this, 'handleEdit', d) }, _('Edit')), ' ',
				E('button', {
					'class': 'btn ' + (d.blocked ? 'cbi-button-positive' : 'cbi-button-negative'),
					'click': ui.createHandlerFn(this, 'handleToggleBlock', d)
				}, d.blocked ? _('Unblock') : _('Block')), ' ',
				E('a', { 'class': 'btn cbi-button-action', 'href': L.url('admin/network/devmon/capture') + '?mac=' + encodeURIComponent(d.mac) }, _('Capture'))
			])
		]);

		cbi_update_table(this.table, rows, E('em', {}, _('No devices found')));
	},

	update(st) {
		this.stats = st;
		this.banner.replaceChildren(dm.statusBanner(st));
		this.renderSummary(st);
		this.guard(() => this.renderTable());
	},

	render(st) {
		this.banner = E('div');
		this.summary = E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:24px;margin:8px 0 16px' });
		this.search = E('input', {
			'type': 'text', 'class': 'cbi-input-text', 'placeholder': _('Filter by name, IP or MAC'),
			'style': 'max-width:280px', 'input': () => this.renderTable()
		});
		this.hideOffline = E('input', { 'type': 'checkbox', 'change': () => this.renderTable() });

		this.table = E('table', { 'class': 'table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('Status')),
				E('th', { 'class': 'th' }, _('Device')),
				E('th', { 'class': 'th' }, _('IP address')),
				E('th', { 'class': 'th' }, _('MAC address')),
				E('th', { 'class': 'th' }, _('Upload')),
				E('th', { 'class': 'th' }, _('Download')),
				E('th', { 'class': 'th' }, _('Total')),
				E('th', { 'class': 'th cbi-section-actions' }, _('Actions'))
			])
		]);

		this.guard = dm.pressGuard(this.table);
		this.update(st);
		poll.add(() => dm.getStats().then((s) => this.update(s)), st.interval || 2);

		return E([], [
			E('h2', {}, _('Devices')),
			E('div', { 'class': 'cbi-map-descr' }, _('Devices seen on the LAN, with realtime rates and totals counted since the service started.')),
			this.banner,
			this.summary,
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:16px;align-items:center;margin-bottom:8px' }, [
				this.search,
				E('label', {}, [ this.hideOffline, ' ', _('Hide offline devices') ])
			]),
			E('div', { 'class': 'cbi-section' }, this.table)
		]);
	}
});

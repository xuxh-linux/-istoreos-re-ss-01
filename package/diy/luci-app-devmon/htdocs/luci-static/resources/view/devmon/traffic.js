'use strict';
'require view';
'require poll';
'require devmon.common as dm';

const TOP_N = 10;

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([ dm.getStats(), dm.getHistory('') ]);
	},

	// 下拉框只在设备集合变化时重建，避免轮询时把用户正在展开的列表冲掉
	syncSelect(st) {
		const devs = (st.devices || []).filter((d) => d.state != 'offline' || d.tx_bytes || d.rx_bytes);
		const sig = devs.map((d) => d.mac + dm.displayName(d)).join('|');
		if (sig == this.selectSig)
			return;
		this.selectSig = sig;

		const cur = this.select.value;
		this.select.replaceChildren(
			E('option', { 'value': '' }, _('All devices')),
			...devs.sort((a, b) => dm.displayName(a).localeCompare(dm.displayName(b)))
				.map((d) => E('option', { 'value': d.mac }, '%s (%s)'.format(dm.displayName(d), d.mac)))
		);
		this.select.value = devs.some((d) => d.mac == cur) ? cur : '';
	},

	renderTop(st) {
		const bar = (v, max, color) => E('div', { 'style': 'height:6px;border-radius:3px;margin-top:2px;background:' + color + ';width:' + (max > 0 ? Math.max(2, v * 100 / max) : 0) + '%' });

		const byRate = (st.devices || []).slice()
			.sort((a, b) => (b.tx_rate + b.rx_rate) - (a.tx_rate + a.rx_rate))
			.filter((d) => d.tx_rate + d.rx_rate > 0)
			.slice(0, TOP_N);
		const maxRate = Math.max(0, ...byRate.map((d) => Math.max(d.tx_rate, d.rx_rate)));

		cbi_update_table(this.rateTable, byRate.map((d) => [
			dm.displayName(d),
			E('div', {}, [ '↑ ' + dm.fmtRate(d.tx_rate), bar(d.tx_rate, maxRate, '#2a78d6') ]),
			E('div', {}, [ '↓ ' + dm.fmtRate(d.rx_rate), bar(d.rx_rate, maxRate, '#eb6834') ])
		]), E('em', {}, _('No active traffic')));

		const byTotal = (st.devices || []).slice()
			.sort((a, b) => (b.tx_bytes + b.rx_bytes) - (a.tx_bytes + a.rx_bytes))
			.filter((d) => d.tx_bytes + d.rx_bytes > 0)
			.slice(0, TOP_N);
		const maxTotal = Math.max(0, ...byTotal.map((d) => Math.max(d.tx_bytes, d.rx_bytes)));

		cbi_update_table(this.totalTable, byTotal.map((d) => [
			dm.displayName(d),
			E('div', {}, [ '↑ ' + dm.fmtBytes(d.tx_bytes), bar(d.tx_bytes, maxTotal, '#2a78d6') ]),
			E('div', {}, [ '↓ ' + dm.fmtBytes(d.rx_bytes), bar(d.rx_bytes, maxTotal, '#eb6834') ])
		]), E('em', {}, _('No traffic recorded yet')));
	},

	refresh() {
		return Promise.all([ dm.getStats(), dm.getHistory(this.select.value) ])
			.then(([ st, h ]) => this.update(st, h));
	},

	update(st, h) {
		this.banner.replaceChildren(dm.statusBanner(st));
		this.syncSelect(st);
		this.chart.update(h.ts, h.series.tx, h.series.rx);
		this.renderTop(st);
	},

	render([ st, h ]) {
		const table = (cols) => E('table', { 'class': 'table' },
			E('tr', { 'class': 'tr table-titles' }, cols.map((c) => E('th', { 'class': 'th' }, c))));

		this.banner = E('div');
		this.chart = new dm.RateChart();
		this.select = E('select', { 'class': 'cbi-input-select', 'change': () => this.refresh() });
		this.rateTable = table([ _('Device'), _('Upload'), _('Download') ]);
		this.totalTable = table([ _('Device'), _('Upload'), _('Download') ]);

		this.update(st, h);
		poll.add(() => this.refresh(), st.interval || 2);

		return E([], [
			E('h2', {}, _('Traffic')),
			E('div', { 'class': 'cbi-map-descr' }, _('Forwarded traffic between LAN devices and other networks. The chart shows the most recent samples kept by the service.')),
			this.banner,
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'margin-bottom:8px' }, [ E('label', {}, _('Show') + ': '), this.select ]),
				this.chart.node
			]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Top devices by current rate')), this.rateTable ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Top devices by total traffic')), this.totalTable ])
		]);
	}
});

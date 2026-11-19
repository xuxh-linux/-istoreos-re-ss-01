'use strict';
'require view';
'require poll';
'require ui';
'require fs';
'require devmon.common as dm';

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([ dm.getStats(), dm.captureList() ]);
	},

	field(label, input, descr) {
		return E('div', { 'class': 'cbi-value' }, [
			E('label', { 'class': 'cbi-value-title' }, label),
			E('div', { 'class': 'cbi-value-field' }, [
				input,
				descr ? E('div', { 'class': 'cbi-value-description' }, descr) : ''
			])
		]);
	},

	// 结果直接显示在按钮旁边；页面顶部的通知在表单下方操作时容易看不到
	setStartMsg(text, color) {
		this.startMsg.style.color = color || '';
		this.startMsg.textContent = text;
	},

	handleStart() {
		const mac = this.devSelect.value;
		const dev = (this.stats.devices || []).find((d) => d.mac == mac);
		if (!mac)
			return this.setStartMsg(_('Please select a device'), '#d03b3b');

		this.setStartMsg(_('Starting capture...'));

		return dm.captureStart(mac, this.ifSelect.value, this.filterInput.value.trim(),
			+this.sizeInput.value || 16, +this.durInput.value || 0, dev ? dm.displayName(dev) : '').then((res) => {
			if (res.error)
				this.setStartMsg(_('Failed to start capture: %s').format(res.error), '#d03b3b');
			else
				this.setStartMsg(_('Capture started, see the list below'), '#1baf7a');
			return this.refreshList();
		}).catch((e) => this.setStartMsg(_('Failed to start capture: %s').format(e.message), '#d03b3b'));
	},

	handleStop(cap) {
		return dm.captureStop(cap.id).then(() => this.refreshList());
	},

	handleDelete(cap) {
		if (!confirm(_('Delete this capture file?')))
			return;
		return dm.captureDelete(cap.id).then(() => this.refreshList());
	},

	// 通过 cgi-download 取文件，绕开 ubus 消息大小限制；需要 ACL 里放行抓包目录的读权限
	handleDownload(cap) {
		return fs.read_direct('%s/%s.pcap'.format(dm.CAP_DIR, cap.id), 'blob').then((blob) => {
			const d = new Date(cap.started * 1000);
			const name = (cap.name || cap.mac).replace(/[^A-Za-z0-9._-]+/g, '_');
			const a = E('a', {
				'href': URL.createObjectURL(blob),
				'download': '%s_%04d%02d%02d-%02d%02d%02d.pcap'.format(name, d.getFullYear(), d.getMonth() + 1,
					d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
			});
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(a.href), 10000);
		}).catch((e) => ui.addNotification(null, E('p', _('Download failed: %s').format(e.message)), 'error'));
	},

	handlePreview(cap) {
		return dm.capturePreview(cap.id, 200).then((res) => {
			ui.showModal(_('Packet preview') + ': ' + (cap.name || cap.mac), [
				E('p', { 'class': 'cbi-value-description' }, _('First 200 packets, decoded by tcpdump on the router. Download the file and open it in Wireshark for full analysis.')),
				E('pre', { 'style': 'max-height:60vh;overflow:auto;font-size:12px;white-space:pre' }, res.error || res.output || _('No packets captured yet')),
				E('div', { 'class': 'right' }, E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close')))
			]);
		});
	},

	statusCell(cap) {
		if (cap.running)
			return E('span', { 'style': 'white-space:nowrap' }, [
				E('span', { 'style': 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#d03b3b' }),
				_('Capturing')
			]);
		if (cap.error)
			return E('span', { 'title': cap.error, 'style': 'color:#d03b3b' }, _('Error') + ': ' + cap.error.split('\n')[0]);
		return E('span', {}, _('Finished'));
	},

	renderList(list) {
		const now = Date.now() / 1000;

		const rows = list.map((c) => {
			const elapsed = (c.running ? now : (c.ended || c.started)) - c.started;
			const limits = [ dm.fmtBytes(c.max_kb * 1024) ];
			if (c.duration > 0)
				limits.push(dm.fmtDuration(c.duration));

			return [
				E('div', {}, [ E('strong', {}, c.name || c.mac), E('div', { 'style': 'font-size:12px;opacity:.7' }, c.mac) ]),
				E('div', { 'style': 'font-size:12px' }, [
					E('div', {}, c.iface),
					c.filter ? E('code', {}, c.filter) : ''
				]),
				dm.fmtDateTime(c.started),
				E('div', {}, [ dm.fmtDuration(elapsed), E('div', { 'style': 'font-size:12px;opacity:.7' }, '≤ ' + limits.join(' / ')) ]),
				dm.fmtBytes(c.size),
				this.statusCell(c),
				E('div', { 'style': 'white-space:nowrap' }, [
					c.running ? E('button', { 'class': 'btn cbi-button-negative', 'click': ui.createHandlerFn(this, 'handleStop', c) }, _('Stop')) : '', ' ',
					E('button', { 'class': 'btn cbi-button', 'click': ui.createHandlerFn(this, 'handlePreview', c), 'disabled': c.size > 24 ? null : '' }, _('Preview')), ' ',
					E('button', { 'class': 'btn cbi-button-action', 'click': ui.createHandlerFn(this, 'handleDownload', c), 'disabled': c.size > 24 ? null : '' }, _('Download')), ' ',
					E('button', { 'class': 'btn cbi-button-remove', 'click': ui.createHandlerFn(this, 'handleDelete', c) }, _('Delete'))
				])
			];
		});

		this.guard(() => cbi_update_table(this.table, rows, E('em', {}, _('No captures yet'))));
	},

	refreshList() {
		return dm.captureList().then((list) => this.renderList(list));
	},

	render([ st, list ]) {
		this.stats = st;

		const want = new URLSearchParams(window.location.search).get('mac') || '';
		const devs = (st.devices || []).slice().sort((a, b) =>
			((a.state == 'offline') - (b.state == 'offline')) || dm.displayName(a).localeCompare(dm.displayName(b)));

		this.devSelect = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '' }, _('-- select device --')),
			...devs.map((d) => E('option', { 'value': d.mac, 'selected': d.mac == want ? '' : null },
				'%s (%s)%s'.format(dm.displayName(d), d.mac, d.state == 'offline' ? ' - ' + _('Offline') : '')))
		]);

		this.ifSelect = E('select', { 'class': 'cbi-input-select' }, (st.ifaces || [ 'br-lan' ]).map((n) =>
			E('option', { 'value': n, 'selected': n == (st.iface || 'br-lan') ? '' : null }, n)));

		this.filterInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': 'tcp port 443 or udp port 53', 'maxlength': 256 });
		this.sizeInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'value': 16, 'min': 1, 'max': 1024 });
		this.durInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'value': 60, 'min': 0, 'max': 86400 });

		this.table = E('table', { 'class': 'table' }, E('tr', { 'class': 'tr table-titles' }, [
			E('th', { 'class': 'th' }, _('Device')),
			E('th', { 'class': 'th' }, _('Interface / filter')),
			E('th', { 'class': 'th' }, _('Started')),
			E('th', { 'class': 'th' }, _('Duration')),
			E('th', { 'class': 'th' }, _('Size')),
			E('th', { 'class': 'th' }, _('Status')),
			E('th', { 'class': 'th cbi-section-actions' }, _('Actions'))
		]));

		this.startMsg = E('span', { 'style': 'margin-left:12px' });
		this.guard = dm.pressGuard(this.table);
		this.renderList(list);
		poll.add(() => this.refreshList(), 2);

		return E([], [
			E('h2', {}, _('Packet Capture')),
			E('div', { 'class': 'cbi-map-descr' }, _('Captures all packets sent or received by one device (matched by MAC address) into a pcap file in RAM. Files are lost on reboot; download them for analysis in Wireshark.')),
			st.tcpdump ? '' : E('div', { 'class': 'alert-message warning' }, _('tcpdump is not installed. Install the tcpdump package to use packet capture.')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('New capture')),
				this.field(_('Device'), this.devSelect),
				this.field(_('Interface'), this.ifSelect, _('Usually the LAN bridge. Wi-Fi clients are also visible on the bridge.')),
				this.field(_('Extra filter'), this.filterInput, _('Optional tcpdump/BPF expression, combined with the device MAC using "and".')),
				this.field(_('Max file size (MB)'), this.sizeInput, _('Capture stops when the file reaches this size. Also limited by the Settings tab and half of the free RAM disk.')),
				this.field(_('Max duration (s)'), this.durInput, _('0 means run until stopped or the size limit is reached.')),
				E('div', { 'class': 'cbi-page-actions', 'style': 'text-align:left' }, [
					E('button', {
						'class': 'btn cbi-button-apply',
						'disabled': st.tcpdump ? null : '',
						'click': ui.createHandlerFn(this, 'handleStart')
					}, _('Start capture')),
					this.startMsg
				])
			]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, _('Captures')), this.table ])
		]);
	}
});

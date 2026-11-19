'use strict';
'require view';
'require form';
'require devmon.common as dm';

return view.extend({
	load() {
		return dm.getStats();
	},

	render(st) {
		const m = new form.Map('devmon', _('Settings'),
			_('Statistics are kept in memory and reset when the service restarts. Device names and block rules are saved permanently.'));

		const s = m.section(form.NamedSection, 'main', 'devmon');
		let o;

		o = s.option(form.Flag, 'enabled', _('Enable service'),
			_('When disabled, traffic counting and device blocking both stop.'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'iface', _('LAN interface'),
			_('Network device whose neighbours are tracked, normally the LAN bridge.'));
		(st.ifaces || []).forEach((n) => o.value(n));
		o.default = 'br-lan';
		o.datatype = 'device';
		o.rmempty = false;

		o = s.option(form.ListValue, 'interval', _('Sampling interval'));
		[ 1, 2, 5, 10 ].forEach((n) => o.value(String(n), _('%d s').format(n)));
		o.default = '2';

		o = s.option(form.Value, 'history', _('History samples'),
			_('Number of samples kept for each realtime chart (10-1800).'));
		o.datatype = 'range(10,1800)';
		o.default = '150';

		o = s.option(form.Value, 'cap_max_mb', _('Capture size limit (MB)'),
			_('Upper bound for a single capture file. Captures are stored in RAM (/tmp).'));
		o.datatype = 'range(1,1024)';
		o.default = '64';

		return m.render();
	}
});

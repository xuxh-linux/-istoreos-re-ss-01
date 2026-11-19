'use strict';
'require view';

// 独立界面在 /devmon/，带上当前 LuCI 会话打开，不用再登录一次
function dashboardUrl() {
	return '/devmon/#sid=' + L.env.sessionid;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	render() {
		window.open(dashboardUrl(), '_blank', 'noopener');

		return E('div', { 'class': 'cbi-section', 'style': 'text-align:center;padding:40px 0' }, [
			E('h2', {}, _('Device Monitor Dashboard')),
			E('p', {}, _('The dashboard opens in a new window. If your browser blocked the pop-up, click the button below.')),
			E('a', { 'class': 'btn cbi-button-action', 'href': dashboardUrl(), 'target': '_blank', 'rel': 'noopener' }, _('Open dashboard'))
		]);
	}
});

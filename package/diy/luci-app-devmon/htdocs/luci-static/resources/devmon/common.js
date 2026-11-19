'use strict';
'require baseclass';
'require rpc';

// devmon 各页面共用的 RPC 声明、格式化函数和实时速率曲线

const SVG_NS = 'http://www.w3.org/2000/svg';

// 上传、下载两条曲线的颜色，取自已做过色盲区分校验的分类色板前两位
const COLOR_TX = '#2a78d6';
const COLOR_RX = '#eb6834';

function svgEl(tag, attrs) {
	const el = document.createElementNS(SVG_NS, tag);
	for (const k in attrs)
		el.setAttribute(k, attrs[k]);
	return el;
}

function fmtUnit(v, units) {
	let i = 0;
	v = +v || 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return (i ? v.toFixed(v >= 100 ? 0 : (v >= 10 ? 1 : 2)) : String(Math.round(v))) + ' ' + units[i];
}

function fmtBytes(v) {
	return fmtUnit(v, [ 'B', 'KB', 'MB', 'GB', 'TB' ]);
}

function fmtRate(v) {
	return fmtUnit(v, [ 'B/s', 'KB/s', 'MB/s', 'GB/s' ]);
}

function fmtTime(ts) {
	if (!ts)
		return '-';
	const d = new Date(ts * 1000);
	return '%02d:%02d:%02d'.format(d.getHours(), d.getMinutes(), d.getSeconds());
}

function fmtDateTime(ts) {
	if (!ts)
		return '-';
	const d = new Date(ts * 1000);
	return '%04d-%02d-%02d %02d:%02d:%02d'.format(d.getFullYear(), d.getMonth() + 1, d.getDate(),
		d.getHours(), d.getMinutes(), d.getSeconds());
}

function fmtDuration(sec) {
	sec = Math.max(0, Math.round(sec || 0));
	if (sec < 60)
		return sec + 's';
	if (sec < 3600)
		return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
	return Math.floor(sec / 3600) + 'h ' + Math.floor(sec % 3600 / 60) + 'm';
}

function displayName(dev) {
	return dev.name || dev.hostname || dev.mac;
}

// 把最大值向上取整到 1/2/5 × 10^n，坐标刻度好读
function niceMax(v) {
	if (v <= 0)
		return 1024;
	const p = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [ 1, 2, 5, 10 ])
		if (v <= m * p)
			return m * p;
	return 10 * p;
}

/*
 * 上传/下载双曲线，带十字准线和悬停提示
 * update() 可以反复调用，只替换数据，不重建 DOM，鼠标停留时提示框会跟着刷新
 */
const RateChart = baseclass.extend({
	__init__() {
		this.W = 800;
		this.H = 240;
		this.pad = { l: 64, r: 12, t: 12, b: 26 };
		this.data = { ts: [], tx: [], rx: [] };
		this.hover = -1;

		this.svg = svgEl('svg', {
			viewBox: '0 0 %d %d'.format(this.W, this.H),
			style: 'width:100%;height:240px;display:block;overflow:visible',
			role: 'img'
		});

		this.gGrid = svgEl('g', {});
		this.pathTx = svgEl('path', { fill: 'none', stroke: COLOR_TX, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' });
		this.pathRx = svgEl('path', { fill: 'none', stroke: COLOR_RX, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' });
		this.cross = svgEl('line', { stroke: 'currentColor', 'stroke-opacity': 0.35, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
		this.overlay = svgEl('rect', { fill: 'transparent', x: this.pad.l, y: 0, width: this.W - this.pad.l - this.pad.r, height: this.H });

		this.svg.append(this.gGrid, this.pathRx, this.pathTx, this.cross, this.overlay);

		this.dotTx = E('div', { style: this.dotStyle(COLOR_TX) });
		this.dotRx = E('div', { style: this.dotStyle(COLOR_RX) });
		this.tip = E('div', {
			style: 'position:absolute;display:none;pointer-events:none;padding:6px 8px;border-radius:4px;' +
				'background:rgba(30,30,30,.9);color:#fff;font-size:12px;line-height:1.5;white-space:nowrap;z-index:10'
		});

		this.legendTx = E('span');
		this.legendRx = E('span');

		this.node = E('div', { 'class': 'devmon-chart' }, [
			E('div', { style: 'display:flex;gap:20px;margin-bottom:6px;font-size:13px' }, [
				E('span', {}, [ this.swatch(COLOR_TX), _('Upload'), ' ', this.legendTx ]),
				E('span', {}, [ this.swatch(COLOR_RX), _('Download'), ' ', this.legendRx ])
			]),
			E('div', { style: 'position:relative' }, [ this.svg, this.dotTx, this.dotRx, this.tip ])
		]);

		this.overlay.addEventListener('mousemove', (ev) => this.onMove(ev));
		this.overlay.addEventListener('mouseleave', () => { this.hover = -1; this.drawHover(); });
	},

	swatch(color) {
		return E('span', { style: 'display:inline-block;width:12px;height:3px;border-radius:2px;vertical-align:middle;margin-right:6px;background:' + color });
	},

	dotStyle(color) {
		return 'position:absolute;display:none;width:8px;height:8px;margin:-6px 0 0 -6px;border-radius:50%;' +
			'pointer-events:none;border:2px solid #fff;background:' + color;
	},

	x(i) {
		const n = this.data.ts.length;
		const w = this.W - this.pad.l - this.pad.r;
		return this.pad.l + (n > 1 ? i * w / (n - 1) : w);
	},

	y(v) {
		const h = this.H - this.pad.t - this.pad.b;
		return this.pad.t + h - (v / this.max) * h;
	},

	update(ts, tx, rx) {
		this.data = { ts: ts || [], tx: tx || [], rx: rx || [] };
		const n = this.data.ts.length;

		// 视口宽度跟随实际像素宽度，避免拉伸导致文字变形
		const pw = Math.round(this.svg.getBoundingClientRect().width);
		if (pw > 0 && pw != this.W) {
			this.W = pw;
			this.svg.setAttribute('viewBox', '0 0 %d %d'.format(this.W, this.H));
			this.overlay.setAttribute('width', this.W - this.pad.l - this.pad.r);
		}

		this.max = niceMax(Math.max(0, ...this.data.tx, ...this.data.rx));
		this.gGrid.replaceChildren();

		for (let k = 0; k <= 4; k++) {
			const v = this.max * k / 4, y = this.y(v);
			this.gGrid.append(svgEl('line', {
				x1: this.pad.l, x2: this.W - this.pad.r, y1: y, y2: y,
				stroke: 'currentColor', 'stroke-opacity': k ? 0.1 : 0.3, 'vector-effect': 'non-scaling-stroke'
			}));
			const t = svgEl('text', { x: this.pad.l - 6, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'currentColor', 'fill-opacity': 0.65 });
			t.textContent = fmtRate(v);
			this.gGrid.append(t);
		}

		for (let k = 0; n > 1 && k < 5; k++) {
			const i = Math.round(k * (n - 1) / 4);
			const t = svgEl('text', {
				x: this.x(i), y: this.H - 6, 'font-size': 11, fill: 'currentColor', 'fill-opacity': 0.65,
				'text-anchor': k == 0 ? 'start' : (k == 4 ? 'end' : 'middle')
			});
			t.textContent = fmtTime(this.data.ts[i]);
			this.gGrid.append(t);
		}

		const path = (arr) => arr.map((v, i) => (i ? 'L' : 'M') + this.x(i).toFixed(1) + ',' + this.y(v).toFixed(1)).join('');
		this.pathTx.setAttribute('d', path(this.data.tx));
		this.pathRx.setAttribute('d', path(this.data.rx));

		this.legendTx.textContent = fmtRate(this.data.tx[n - 1]);
		this.legendRx.textContent = fmtRate(this.data.rx[n - 1]);

		this.drawHover();
	},

	onMove(ev) {
		const n = this.data.ts.length;
		if (n < 1)
			return;
		const rect = this.svg.getBoundingClientRect();
		const vx = (ev.clientX - rect.left) * this.W / rect.width;
		const w = this.W - this.pad.l - this.pad.r;
		this.hover = Math.max(0, Math.min(n - 1, Math.round((vx - this.pad.l) * (n - 1) / w)));
		this.drawHover();
	},

	drawHover() {
		const i = this.hover, d = this.data;
		const show = i >= 0 && i < d.ts.length;

		this.cross.setAttribute('visibility', show ? 'visible' : 'hidden');
		this.tip.style.display = this.dotTx.style.display = this.dotRx.style.display = show ? 'block' : 'none';
		if (!show)
			return;

		const rect = this.svg.getBoundingClientRect();
		const sx = rect.width / this.W, sy = rect.height / this.H;
		const x = this.x(i);

		this.cross.setAttribute('x1', x);
		this.cross.setAttribute('x2', x);
		this.cross.setAttribute('y1', this.pad.t);
		this.cross.setAttribute('y2', this.H - this.pad.b);

		this.dotTx.style.left = this.dotRx.style.left = (x * sx) + 'px';
		this.dotTx.style.top = (this.y(d.tx[i]) * sy) + 'px';
		this.dotRx.style.top = (this.y(d.rx[i]) * sy) + 'px';

		this.tip.replaceChildren(
			E('div', { style: 'opacity:.8' }, fmtTime(d.ts[i])),
			E('div', {}, [ this.swatch(COLOR_TX), _('Upload') + ': ' + fmtRate(d.tx[i]) ]),
			E('div', {}, [ this.swatch(COLOR_RX), _('Download') + ': ' + fmtRate(d.rx[i]) ])
		);

		// 提示框放在准线右侧，靠近右边缘时翻到左侧
		const left = x * sx + 12;
		this.tip.style.top = '8px';
		if (left + 170 > rect.width) {
			this.tip.style.left = '';
			this.tip.style.right = (rect.width - x * sx + 12) + 'px';
		}
		else {
			this.tip.style.right = '';
			this.tip.style.left = left + 'px';
		}
	}
});

return baseclass.extend({
	RateChart: RateChart,

	fmtBytes: fmtBytes,
	fmtRate: fmtRate,
	fmtTime: fmtTime,
	fmtDateTime: fmtDateTime,
	fmtDuration: fmtDuration,
	displayName: displayName,

	CAP_DIR: '/tmp/devmon/cap',

	getStats: rpc.declare({
		object: 'luci.devmon',
		method: 'getStats',
		expect: { }
	}),

	getHistory: rpc.declare({
		object: 'luci.devmon',
		method: 'getHistory',
		params: [ 'mac' ],
		expect: { }
	}),

	setDevice: rpc.declare({
		object: 'luci.devmon',
		method: 'setDevice',
		params: [ 'mac', 'name', 'blocked' ],
		expect: { }
	}),

	captureStart: rpc.declare({
		object: 'luci.devmon',
		method: 'captureStart',
		params: [ 'mac', 'iface', 'filter', 'max_mb', 'duration', 'name' ],
		expect: { }
	}),

	captureStop: rpc.declare({
		object: 'luci.devmon',
		method: 'captureStop',
		params: [ 'id' ],
		expect: { }
	}),

	captureDelete: rpc.declare({
		object: 'luci.devmon',
		method: 'captureDelete',
		params: [ 'id' ],
		expect: { }
	}),

	captureList: rpc.declare({
		object: 'luci.devmon',
		method: 'captureList',
		expect: { captures: [] }
	}),

	capturePreview: rpc.declare({
		object: 'luci.devmon',
		method: 'capturePreview',
		params: [ 'id', 'count' ],
		expect: { }
	}),

	// cbi_update_table 每次都整行重建，按下到松开之间重建会让按钮的 click 丢失
	// 返回的函数用来包住表格刷新：按住期间只记下最后一次刷新，松开且 click 派发完后再补上
	pressGuard(node) {
		let pressed = false, pending = null;

		const release = () => {
			if (!pressed)
				return;
			pressed = false;
			setTimeout(() => {
				const fn = pending;
				pending = null;
				if (fn)
					fn();
			}, 50);
		};

		node.addEventListener('pointerdown', () => { pressed = true; });
		document.addEventListener('pointerup', release);
		document.addEventListener('pointercancel', release);

		return (fn) => {
			if (pressed)
				pending = fn;
			else
				fn();
		};
	},

	// 守护进程没在跑或开了流量卸载时，在页面顶部给出提示
	statusBanner(st) {
		const msgs = [];
		if (!st.running)
			msgs.push(E('p', {}, _('The devmon service is not running; statistics are not updated. Enable it on the Settings tab.')));
		if (st.offload)
			msgs.push(E('p', {}, _('Flow offloading is enabled in the firewall. Offloaded traffic bypasses the counters, so rates will be lower than real. Disable software/hardware offloading for accurate numbers.')));
		return E('div', { 'class': 'devmon-banner' }, msgs.length ? E('div', { 'class': 'alert-message warning' }, msgs) : []);
	}
});

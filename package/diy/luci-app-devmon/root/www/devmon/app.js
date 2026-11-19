/* DevMon 独立界面：通过 uhttpd 的 /ubus JSON-RPC 调用 luci.devmon，不依赖 LuCI */
'use strict';

(() => {

const NULL_SID = '00000000000000000000000000000000';
const SID_KEY = 'devmon_sid';
const CAP_DIR = '/tmp/devmon/cap';

const C_UP = '#7cc8ff';
const C_DOWN = '#ff9cc2';
const MACARON = [ '#8fd3ff', '#93e5c7', '#ffadc9', '#c4b3ff', '#ffcfa3', '#fff0a0' ];

// 设备卡片迷你曲线保留的采样点数，由页面自己累积，不额外请求
const SPARK_POINTS = 60;
// 实时日志在内存里最多保留的行数；更早的内容请下载完整日志
const LIVE_MAX_LINES = 50000;
// 日志区最多同时渲染的行数，再多浏览器会卡
const LIVE_MAX_DOM = 2000;
// 查看已结束的抓包时最多加载末尾这么多字节
const REPLAY_MAX_BYTES = 2 * 1024 * 1024;

let sid = null;
let stats = { devices: [], total: {} };
let tab = 'overview';
let statsTimer = null;
const spark = {};    // mac -> { tx: [], rx: [] }
const peak = { tx: 0, rx: 0 };

/* ---------- 工具函数 ---------- */

const $ = (id) => document.getElementById(id);

// 只用 textContent 写入文本：抓包内容和主机名都可能带有任意字符
function el(tag, attrs, children) {
	const n = document.createElement(tag);
	for (const k in attrs || {}) {
		const v = attrs[k];
		if (v == null || v === false)
			continue;
		if (k == 'class')
			n.className = v;
		else if (k == 'style')
			n.style.cssText = v;
		else if (k.startsWith('on'))
			n.addEventListener(k.slice(2), v);
		else if (k == 'text')
			n.textContent = v;
		else
			n.setAttribute(k, v === true ? '' : v);
	}
	for (const c of [].concat(children ?? [])) {
		if (c == null || c === false)
			continue;
		n.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return n;
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
const fmtBytes = (v) => fmtUnit(v, [ 'B', 'KB', 'MB', 'GB', 'TB' ]);
const fmtRate = (v) => fmtUnit(v, [ 'B/s', 'KB/s', 'MB/s', 'GB/s' ]);

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtClock(ts) {
	const d = new Date(ts * 1000);
	return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function fmtDateTime(ts) {
	const d = new Date(ts * 1000);
	return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + fmtClock(ts);
}

function fmtDuration(sec) {
	sec = Math.max(0, Math.round(sec || 0));
	if (sec < 60)
		return sec + 's';
	if (sec < 3600)
		return Math.floor(sec / 60) + 'm' + pad2(sec % 60) + 's';
	return Math.floor(sec / 3600) + 'h' + pad2(Math.floor(sec % 3600 / 60)) + 'm';
}

const devName = (d) => d.name || d.hostname || d.mac;

function colorOf(key) {
	let h = 0;
	for (const ch of key)
		h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return MACARON[h % MACARON.length];
}

function toast(text, kind) {
	const t = el('div', { class: 'toast ' + (kind || ''), text: text });
	$('toasts').append(t);
	setTimeout(() => t.remove(), kind == 'err' ? 6000 : 3000);
}

// 返回 Promise：确认为 true，取消为 false
function modal(title, body, actions, wide) {
	return new Promise((resolve) => {
		const close = (v) => { bg.remove(); resolve(v); };
		const box = el('div', { class: 'modal' + (wide ? ' wide' : '') }, [
			el('h3', { text: title }),
			body,
			el('div', { class: 'modal-actions' }, (actions || [ [ '关闭', 'ghost', false ] ]).map(([ label, cls, val ]) =>
				el('button', { class: 'btn ' + cls, text: label, onclick: () => close(typeof val == 'function' ? val() : val) })))
		]);
		const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target == bg) close(false); } }, box);
		document.body.append(bg);
		const first = box.querySelector('input');
		if (first)
			first.focus();
	});
}

// 坐标上限按 1024 进制取整到 1/2/5 × 10^n，刻度显示成 20 MB/s 这样的整数而不是 19.1 MB/s
function niceMax(v) {
	if (v <= 0)
		return 1024;
	let unit = 1;
	while (v >= 1024 * unit)
		unit *= 1024;
	const x = v / unit;
	const p = Math.pow(10, Math.floor(Math.log10(x)));
	for (const m of [ 1, 2, 4, 5, 8, 10 ])
		if (x <= m * p)
			return m * p * unit;
	return 10 * p * unit;
}

/* ---------- ubus RPC ---------- */

let rpcId = 0;

class AuthError extends Error {}

async function ubus(object, method, args, useSid) {
	const res = await fetch('/ubus', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: ++rpcId, method: 'call',
			params: [ useSid ?? sid ?? NULL_SID, object, method, args || {} ]
		})
	});
	const j = await res.json();

	// 会话失效时 rpcd 返回 -32002 或状态码 6，统一当成需要重新登录
	if (j.error) {
		if (j.error.code == -32002)
			throw new AuthError(j.error.message);
		throw new Error(j.error.message);
	}
	const [ code, data ] = j.result;
	if (code == 6)
		throw new AuthError('Permission denied');
	if (code != 0)
		throw new Error('ubus ' + object + '.' + method + ' failed: ' + code);
	return data || {};
}

const dm = (method, args) => ubus('luci.devmon', method, args);

function handleErr(e) {
	if (e instanceof AuthError)
		return showLogin('登录已过期，请重新登录');
	toast(e.message, 'err');
}

// 通过 cgi-download 下载，浏览器直接保存文件，不经过 JS 内存；提交到隐藏 iframe，不会多开空白标签页
function download(path, filename) {
	let frame = $('dl-frame');
	if (!frame) {
		frame = el('iframe', { id: 'dl-frame', name: 'dl-frame', style: 'display:none' });
		document.body.append(frame);
	}
	const f = el('form', { method: 'POST', action: '/cgi-bin/cgi-download', target: 'dl-frame', style: 'display:none' }, [
		el('input', { name: 'sessionid', value: sid }),
		el('input', { name: 'path', value: path }),
		el('input', { name: 'filename', value: filename })
	]);
	document.body.append(f);
	f.submit();
	f.remove();
}

function saveText(text, filename) {
	const a = el('a', { href: URL.createObjectURL(new Blob([ text ], { type: 'text/plain' })), download: filename });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ---------- 登录 ---------- */

function showLogin(msg) {
	stopTimers();
	sid = null;
	try { sessionStorage.removeItem(SID_KEY); } catch (e) {}
	$('app').classList.add('hidden');
	$('login').classList.remove('hidden');
	$('login-err').textContent = msg || '';
	$('login-pass').focus();
}

async function enterApp() {
	$('login').classList.add('hidden');
	$('app').classList.remove('hidden');
	try { sessionStorage.setItem(SID_KEY, sid); } catch (e) {}

	ubus('system', 'board').then((b) => {
		$('host-name').textContent = (b.hostname || '') + (b.model ? ' · ' + b.model : '');
	}).catch(() => {});

	await refreshStats();
	switchTab(tab);
}

$('login-form').addEventListener('submit', async (ev) => {
	ev.preventDefault();
	$('login-err').textContent = '';
	try {
		const r = await ubus('session', 'login', {
			username: $('login-user').value.trim() || 'root',
			password: $('login-pass').value,
			timeout: 7200
		}, NULL_SID);
		sid = r.ubus_rpc_session;
		$('login-pass').value = '';
		enterApp();
	} catch (e) {
		$('login-err').textContent = (e instanceof AuthError) ? '用户名或密码错误' : ('登录失败：' + e.message);
	}
});

$('btn-logout').addEventListener('click', () => {
	ubus('session', 'destroy', {}).catch(() => {});
	showLogin();
});

/* ---------- 曲线 ---------- */

// 上传/下载双曲线，带发光描边、渐变填充、十字准线和悬停提示
class RateChart {
	constructor(wrap, legend) {
		this.wrap = wrap;
		this.legend = legend;
		this.canvas = el('canvas');
		this.tip = el('div', { class: 'tooltip hidden' });
		wrap.replaceChildren(this.canvas, this.tip);
		this.data = { ts: [], tx: [], rx: [] };
		this.hover = -1;
		this.pad = { l: 66, r: 14, t: 14, b: 26 };

		this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
		this.canvas.addEventListener('mouseleave', () => { this.hover = -1; this.draw(); });
		if (window.ResizeObserver)
			new ResizeObserver(() => this.draw()).observe(wrap);
	}

	set(ts, tx, rx) {
		this.data = { ts: ts || [], tx: tx || [], rx: rx || [] };
		const n = this.data.ts.length;
		if (this.legend)
			this.legend.replaceChildren(
				el('span', {}, [ el('i', { style: 'background:' + C_UP }), '上传 ', el('b', { text: fmtRate(this.data.tx[n - 1]) }) ]),
				el('span', {}, [ el('i', { style: 'background:' + C_DOWN }), '下载 ', el('b', { text: fmtRate(this.data.rx[n - 1]) }) ]));
		this.draw();
	}

	x(i) {
		const n = this.data.ts.length, w = this.w - this.pad.l - this.pad.r;
		return this.pad.l + (n > 1 ? i * w / (n - 1) : w);
	}

	y(v) {
		const h = this.h - this.pad.t - this.pad.b;
		return this.pad.t + h - (v / this.max) * h;
	}

	draw() {
		const rect = this.wrap.getBoundingClientRect();
		if (!rect.width)
			return;
		const dpr = window.devicePixelRatio || 1;
		this.w = rect.width;
		this.h = rect.height;
		this.canvas.width = Math.round(this.w * dpr);
		this.canvas.height = Math.round(this.h * dpr);

		const g = this.canvas.getContext('2d');
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, this.w, this.h);

		const d = this.data, n = d.ts.length;
		this.max = niceMax(Math.max(0, ...d.tx, ...d.rx));

		g.font = '11px -apple-system, "PingFang SC", sans-serif';
		g.textBaseline = 'middle';
		for (let k = 0; k <= 4; k++) {
			const v = this.max * k / 4, y = Math.round(this.y(v)) + .5;
			g.strokeStyle = k ? 'rgba(150,175,255,.08)' : 'rgba(150,175,255,.25)';
			g.lineWidth = 1;
			g.beginPath();
			g.moveTo(this.pad.l, y);
			g.lineTo(this.w - this.pad.r, y);
			g.stroke();
			g.fillStyle = '#6f7ba3';
			g.textAlign = 'right';
			g.fillText(fmtRate(v), this.pad.l - 8, y);
		}

		g.textBaseline = 'alphabetic';
		for (let k = 0; n > 1 && k < 5; k++) {
			const i = Math.round(k * (n - 1) / 4);
			g.textAlign = k == 0 ? 'left' : (k == 4 ? 'right' : 'center');
			g.fillText(fmtClock(d.ts[i]), this.x(i), this.h - 7);
		}

		if (n < 2) {
			g.textAlign = 'center';
			g.fillStyle = '#6f7ba3';
			g.fillText('正在收集数据…', this.w / 2, this.h / 2);
			return;
		}

		for (const [ arr, color ] of [ [ d.rx, C_DOWN ], [ d.tx, C_UP ] ]) {
			const base = this.y(0);
			const grad = g.createLinearGradient(0, this.pad.t, 0, base);
			grad.addColorStop(0, color + '55');
			grad.addColorStop(1, color + '00');

			g.beginPath();
			arr.forEach((v, i) => i ? g.lineTo(this.x(i), this.y(v)) : g.moveTo(this.x(i), this.y(v)));
			g.lineTo(this.x(n - 1), base);
			g.lineTo(this.x(0), base);
			g.closePath();
			g.fillStyle = grad;
			g.fill();

			g.beginPath();
			arr.forEach((v, i) => i ? g.lineTo(this.x(i), this.y(v)) : g.moveTo(this.x(i), this.y(v)));
			g.strokeStyle = color;
			g.lineWidth = 2;
			g.lineJoin = 'round';
			g.shadowColor = color;
			g.shadowBlur = 10;
			g.stroke();
			g.shadowBlur = 0;
		}

		const i = this.hover;
		if (i < 0 || i >= n) {
			this.tip.classList.add('hidden');
			return;
		}

		const x = this.x(i);
		g.strokeStyle = 'rgba(232,237,255,.35)';
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo(x, this.pad.t);
		g.lineTo(x, this.y(0));
		g.stroke();

		for (const [ v, color ] of [ [ d.tx[i], C_UP ], [ d.rx[i], C_DOWN ] ]) {
			g.beginPath();
			g.arc(x, this.y(v), 5, 0, Math.PI * 2);
			g.fillStyle = color;
			g.fill();
			g.lineWidth = 2;
			g.strokeStyle = '#0b1230';
			g.stroke();
		}

		this.tip.replaceChildren(
			el('div', { class: 'dim', text: fmtClock(d.ts[i]) }),
			el('div', {}, [ el('span', { style: 'color:' + C_UP, text: '● ' }), '上传 ' + fmtRate(d.tx[i]) ]),
			el('div', {}, [ el('span', { style: 'color:' + C_DOWN, text: '● ' }), '下载 ' + fmtRate(d.rx[i]) ]));
		this.tip.classList.remove('hidden');
		const tw = this.tip.offsetWidth;
		this.tip.style.left = (x + 14 + tw > this.w ? x - 14 - tw : x + 14) + 'px';
		this.tip.style.top = '10px';
	}

	onMove(e) {
		const n = this.data.ts.length;
		if (n < 2)
			return;
		const r = this.canvas.getBoundingClientRect();
		const w = this.w - this.pad.l - this.pad.r;
		this.hover = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - this.pad.l) * (n - 1) / w)));
		this.draw();
	}
}

function drawSpark(canvas, tx, rx) {
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth, h = canvas.clientHeight;
	if (!w)
		return;
	canvas.width = w * dpr;
	canvas.height = h * dpr;
	const g = canvas.getContext('2d');
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	const max = Math.max(1, ...tx, ...rx);
	for (const [ arr, color ] of [ [ rx, C_DOWN ], [ tx, C_UP ] ]) {
		if (arr.length < 2)
			continue;
		g.beginPath();
		arr.forEach((v, i) => {
			const x = i * w / (SPARK_POINTS - 1) + (SPARK_POINTS - arr.length) * w / (SPARK_POINTS - 1);
			const y = h - 2 - (v / max) * (h - 4);
			i ? g.lineTo(x, y) : g.moveTo(x, y);
		});
		g.strokeStyle = color;
		g.lineWidth = 1.5;
		g.stroke();
	}
}

/* ---------- 统计轮询 ---------- */

function stopTimers() {
	clearTimeout(statsTimer);
	statsTimer = null;
	live.stopPolling();
	clearInterval(capListTimer);
	capListTimer = null;
}

async function refreshStats() {
	clearTimeout(statsTimer);
	try {
		stats = await dm('getStats');
		for (const d of stats.devices || []) {
			const s = spark[d.mac] ??= { tx: [], rx: [] };
			s.tx.push(d.tx_rate);
			s.rx.push(d.rx_rate);
			if (s.tx.length > SPARK_POINTS) { s.tx.shift(); s.rx.shift(); }
		}
		peak.tx = Math.max(peak.tx, stats.total?.tx_rate || 0);
		peak.rx = Math.max(peak.rx, stats.total?.rx_rate || 0);
		renderHeader();
		if (tab == 'overview')
			await renderOverview();
		else if (tab == 'devices')
			renderDevices();
		else if (tab == 'capture')
			syncCaptureForm();
	} catch (e) {
		if (e instanceof AuthError)
			return showLogin('登录已过期，请重新登录');
		$('svc-text').textContent = '连接失败';
		$('svc-dot').style.background = 'var(--rose)';
	}
	statsTimer = setTimeout(refreshStats, (stats.interval || 2) * 1000);
}

function renderHeader() {
	const devs = stats.devices || [];
	const online = devs.filter((d) => d.state == 'online').length;

	$('svc-dot').style.background = stats.running ? 'var(--mint)' : 'var(--rose)';
	$('svc-dot').style.color = stats.running ? 'var(--mint)' : 'var(--rose)';
	$('svc-dot').classList.toggle('pulse', !!stats.running);
	$('svc-text').textContent = stats.running ? '监控运行中' : '服务未运行';
	$('pill-online').textContent = online + ' / ' + devs.length;
	$('pill-up').textContent = fmtRate(stats.total?.tx_rate);
	$('pill-down').textContent = fmtRate(stats.total?.rx_rate);

	const msgs = [];
	if (!stats.running)
		msgs.push('监控服务没有运行，数据不会更新。请到“设置”里启用服务。');
	if (stats.offload)
		msgs.push('防火墙开启了流量卸载，被卸载的连接不经过计数，显示的速率会偏低。');
	$('banner').replaceChildren(...msgs.map((m) => el('div', { class: 'banner', text: '⚠ ' + m })));
}

/* ---------- 总览 ---------- */

let ovChart = null;
let ovSelSig = '';

async function renderOverview() {
	const devs = stats.devices || [];
	const online = devs.filter((d) => d.state == 'online');
	const totTx = devs.reduce((a, d) => a + d.tx_bytes, 0);
	const totRx = devs.reduce((a, d) => a + d.rx_bytes, 0);

	$('st-online').textContent = online.length;
	$('st-online-sub').textContent = '共发现 ' + devs.length + ' 台 · 拉黑 ' + devs.filter((d) => d.blocked).length + ' 台';
	$('st-up').textContent = fmtRate(stats.total?.tx_rate);
	$('st-up-sub').textContent = '本次打开峰值 ' + fmtRate(peak.tx);
	$('st-down').textContent = fmtRate(stats.total?.rx_rate);
	$('st-down-sub').textContent = '本次打开峰值 ' + fmtRate(peak.rx);
	$('st-total').textContent = fmtBytes(totTx + totRx);
	$('st-total-sub').textContent = '↑ ' + fmtBytes(totTx) + '  ↓ ' + fmtBytes(totRx);

	// 下拉框只在设备集合变化时重建，避免轮询时把用户正展开的列表冲掉
	const sel = $('ov-dev');
	const opts = devs.filter((d) => d.state != 'offline' || d.tx_bytes || d.rx_bytes);
	const sig = opts.map((d) => d.mac + devName(d)).join('|');
	if (sig != ovSelSig) {
		ovSelSig = sig;
		const cur = sel.value;
		sel.replaceChildren(el('option', { value: '', text: '全部设备' }),
			...opts.map((d) => el('option', { value: d.mac, text: devName(d) })));
		sel.value = opts.some((d) => d.mac == cur) ? cur : '';
	}

	ovChart ??= new RateChart($('ov-chart'), $('ov-legend'));
	const h = await dm('getHistory', { mac: sel.value });
	ovChart.set(h.ts, h.series?.tx, h.series?.rx);

	const top = devs.filter((d) => d.tx_rate + d.rx_rate > 0)
		.sort((a, b) => (b.tx_rate + b.rx_rate) - (a.tx_rate + a.rx_rate)).slice(0, 8);
	const max = Math.max(1, ...top.map((d) => Math.max(d.tx_rate, d.rx_rate)));
	$('ov-rank').replaceChildren(...(top.length ? top.map((d) => el('div', { class: 'rank-item' }, [
		el('div', { class: 'avatar', style: 'background:' + colorOf(d.mac), text: devName(d).slice(0, 1).toUpperCase() }),
		el('div', {}, [
			el('div', { class: 'rank-name' }, [ el('span', { text: devName(d) }),
				el('span', { class: 'dim', text: '↑' + fmtRate(d.tx_rate) + ' ↓' + fmtRate(d.rx_rate) }) ]),
			el('div', { class: 'bars' }, [
				el('div', { style: 'background:' + C_UP + ';width:' + (d.tx_rate * 100 / max) + '%' }),
				el('div', { style: 'background:' + C_DOWN + ';width:' + (d.rx_rate * 100 / max) + '%' })
			])
		])
	])) : [ el('div', { class: 'empty-state', text: '当前没有设备在传输数据' }) ]));
}

$('ov-dev').addEventListener('change', () => renderOverview().catch(handleErr));

/* ---------- 设备管理 ---------- */

const STATE_RANK = { online: 0, idle: 1, offline: 2 };
const cards = {};    // mac -> 卡片节点引用；轮询时原地更新文字，不重建，按钮点击不会丢
let devFilter = 'all';
let devOrderSig = '';

function buildCard(mac) {
	const r = {};
	r.avatar = el('div', { class: 'avatar' });
	r.name = el('b');
	r.mac = el('small', { text: mac });
	r.state = el('span', { class: 'state' });
	r.ips = el('div', { class: 'dev-ips' });
	r.up = el('div', { class: 'v', style: 'color:' + C_UP });
	r.upT = el('div', { class: 't' });
	r.down = el('div', { class: 'v', style: 'color:' + C_DOWN });
	r.downT = el('div', { class: 't' });
	r.spark = el('canvas', { class: 'spark' });
	r.block = el('button', { class: 'btn xs', onclick: () => toggleBlock(stats.devices.find((d) => d.mac == mac)) });

	r.root = el('div', { class: 'dev' }, [
		el('div', { class: 'dev-head' }, [ r.avatar, el('div', { class: 'dev-title' }, [ r.name, r.mac ]), r.state ]),
		r.ips,
		el('div', { class: 'dev-rates' }, [
			el('div', { class: 'rate-box' }, [ el('div', { class: 'k', text: '↑ 上传' }), r.up, r.upT ]),
			el('div', { class: 'rate-box' }, [ el('div', { class: 'k', text: '↓ 下载' }), r.down, r.downT ])
		]),
		r.spark,
		el('div', { class: 'dev-actions' }, [
			el('button', { class: 'btn ghost xs', text: '📈 曲线', onclick: () => showDevChart(mac) }),
			el('button', { class: 'btn ghost xs', text: '✎ 改名', onclick: () => renameDev(stats.devices.find((d) => d.mac == mac)) }),
			r.block,
			el('button', { class: 'btn pink xs', text: '◈ 抓包', onclick: () => { capPreselect = mac; switchTab('capture'); } })
		])
	]);
	return r;
}

function renderDevices() {
	const q = $('dev-search').value.trim().toLowerCase();
	const sortBy = $('dev-sort').value;
	const devs = (stats.devices || []).filter((d) => {
		if (devFilter == 'online' && d.state != 'online')
			return false;
		if (devFilter == 'blocked' && !d.blocked)
			return false;
		return !q || [ d.name, d.hostname, d.mac, ...(d.ip4 || []), ...(d.ip6 || []) ].some((s) => s && s.toLowerCase().includes(q));
	}).sort((a, b) => {
		if (sortBy == 'name')
			return devName(a).localeCompare(devName(b));
		const sa = STATE_RANK[a.state] - STATE_RANK[b.state];
		if (sortBy == 'total')
			return ((b.tx_bytes + b.rx_bytes) - (a.tx_bytes + a.rx_bytes)) || sa;
		return sa || ((b.tx_rate + b.rx_rate) - (a.tx_rate + a.rx_rate)) || devName(a).localeCompare(devName(b));
	});

	for (const d of devs) {
		const r = cards[d.mac] ??= buildCard(d.mac);
		const st = d.blocked ? 'blocked' : d.state;
		r.root.className = 'dev ' + (d.state == 'offline' ? 'offline ' : '') + (d.blocked ? 'blocked' : '');
		r.avatar.style.background = colorOf(d.mac);
		r.avatar.textContent = devName(d).slice(0, 1).toUpperCase();
		r.name.textContent = devName(d);
		r.name.title = d.hostname ? '主机名：' + d.hostname : '';
		r.state.className = 'state ' + st;
		r.state.textContent = { online: '● 在线', idle: '● 空闲', offline: '● 离线', blocked: '⛔ 已拉黑' }[st];
		r.ips.replaceChildren(...([ ...(d.ip4 || []), ...(d.ip6 || []) ].slice(0, 3).map((ip) => el('div', { text: ip, title: ip }))),
			...(d.ip4.length + d.ip6.length > 3 ? [ el('div', { class: 'dim', text: '+' + (d.ip4.length + d.ip6.length - 3) + ' 个地址' }) ] : []),
			...(d.ip4.length + d.ip6.length == 0 ? [ el('div', { class: 'dim', text: '暂无地址' }) ] : []));
		r.up.textContent = fmtRate(d.tx_rate);
		r.down.textContent = fmtRate(d.rx_rate);
		r.upT.textContent = '累计 ' + fmtBytes(d.tx_bytes);
		r.downT.textContent = '累计 ' + fmtBytes(d.rx_bytes);
		r.block.textContent = d.blocked ? '✓ 解除拉黑' : '⛔ 拉黑';
		r.block.className = 'btn xs ' + (d.blocked ? 'mint' : 'danger');
	}

	const grid = $('dev-grid');
	const sig = devs.map((d) => d.mac).join(',');
	if (sig != devOrderSig) {
		devOrderSig = sig;
		grid.replaceChildren(...(devs.length ? devs.map((d) => cards[d.mac].root) : [ el('div', { class: 'empty-state', text: '没有符合条件的设备' }) ]));
	}

	for (const d of devs) {
		const s = spark[d.mac];
		if (s)
			drawSpark(cards[d.mac].spark, s.tx, s.rx);
	}
}

$('dev-search').addEventListener('input', renderDevices);
$('dev-sort').addEventListener('change', renderDevices);
document.querySelectorAll('[data-f]').forEach((c) => c.addEventListener('click', () => {
	devFilter = c.dataset.f;
	document.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x == c));
	renderDevices();
}));

async function renameDev(d) {
	if (!d)
		return;
	const input = el('input', { type: 'text', value: d.name || '', placeholder: d.hostname || d.mac, maxlength: 64, style: 'width:100%' });
	const ok = await modal('设备改名 · ' + d.mac, el('div', {}, [
		input, el('div', { class: 'dim', style: 'margin-top:8px;font-size:12px', text: '留空则显示 DHCP 主机名' })
	]), [ [ '取消', 'ghost', false ], [ '保存', '', true ] ]);
	if (!ok)
		return;
	try {
		const r = await dm('setDevice', { mac: d.mac, name: input.value, blocked: d.blocked });
		if (r.error)
			throw new Error(r.error);
		toast('已保存', 'ok');
		refreshStats();
	} catch (e) { handleErr(e); }
}

async function toggleBlock(d) {
	if (!d)
		return;
	if (!d.blocked) {
		const ok = await modal('禁止上网', el('p', { text: '确定禁止「' + devName(d) + '」上网吗？已有连接会立即断开，访问路由器本身不受影响。' }),
			[ [ '取消', 'ghost', false ], [ '⛔ 拉黑', 'danger', true ] ]);
		if (!ok)
			return;
	}
	try {
		const r = await dm('setDevice', { mac: d.mac, name: d.name, blocked: !d.blocked });
		if (r.error)
			throw new Error(r.error);
		toast(d.blocked ? '已解除拉黑' : '已拉黑，下个采样周期生效', 'ok');
		refreshStats();
	} catch (e) { handleErr(e); }
}

function showDevChart(mac) {
	const d = stats.devices.find((x) => x.mac == mac);
	const legend = el('div', { class: 'legend' });
	const wrap = el('div', { class: 'chart-wrap' });
	let alive = true;
	modal('实时流量 · ' + (d ? devName(d) : mac), el('div', {}, [ legend, wrap ]), null, true).then(() => { alive = false; });

	const chart = new RateChart(wrap, legend);
	const tick = async () => {
		if (!alive)
			return;
		try {
			const h = await dm('getHistory', { mac: mac });
			chart.set(h.ts, h.series?.tx, h.series?.rx);
		} catch (e) { handleErr(e); }
		setTimeout(tick, (stats.interval || 2) * 1000);
	};
	tick();
}

/* ---------- 数据包抓取 ---------- */

let capPreselect = '';
let capListTimer = null;
let capFormSig = '';
const capItems = {};    // id -> 抓包记录节点引用，原地更新

function syncCaptureForm() {
	const devs = (stats.devices || []).slice().sort((a, b) =>
		((a.state == 'offline') - (b.state == 'offline')) || devName(a).localeCompare(devName(b)));
	const sig = devs.map((d) => d.mac + devName(d) + d.state).join('|') + '#' + (stats.ifaces || []).join(',');

	if (sig != capFormSig) {
		capFormSig = sig;
		const sel = $('cap-dev'), cur = capPreselect || sel.value;
		sel.replaceChildren(el('option', { value: '', text: '-- 选择设备 --' }),
			...devs.map((d) => el('option', { value: d.mac, text: devName(d) + '  ' + d.mac + (d.state == 'offline' ? '  (离线)' : '') })));
		sel.value = devs.some((d) => d.mac == cur) ? cur : '';

		const ifs = $('cap-iface'), curIf = ifs.value || stats.iface || 'br-lan';
		ifs.replaceChildren(...(stats.ifaces || [ 'br-lan' ]).map((n) => el('option', { value: n, text: n })));
		ifs.value = curIf;
	}
	if (capPreselect) {
		$('cap-dev').value = capPreselect;
		capPreselect = '';
	}

	$('cap-warn').replaceChildren(stats.tcpdump ? '' : el('div', { class: 'banner', text: '⚠ 未安装 tcpdump，无法抓包。请执行 apk add tcpdump' }));
	$('cap-start').disabled = !stats.tcpdump;
}

function setCapMsg(text, kind) {
	$('cap-msg').className = 'msg ' + (kind || '');
	$('cap-msg').textContent = text;
}

$('cap-start').addEventListener('click', async () => {
	const mac = $('cap-dev').value;
	if (!mac)
		return setCapMsg('请先选择目标设备', 'err');
	const d = stats.devices.find((x) => x.mac == mac);

	$('cap-start').disabled = true;
	setCapMsg('正在启动抓包…');
	try {
		const r = await dm('captureStart', {
			mac: mac,
			iface: $('cap-iface').value,
			filter: $('cap-filter').value.trim(),
			max_mb: +$('cap-size').value || 16,
			duration: +$('cap-dur').value || 0,
			name: d ? devName(d) : ''
		});
		if (r.error)
			throw new Error(r.error);
		setCapMsg('✓ 已开始抓包，右侧实时显示', 'ok');
		await refreshCapList();
		live.open(r.id);
	} catch (e) {
		if (e instanceof AuthError)
			return handleErr(e);
		setCapMsg('启动失败：' + e.message, 'err');
	} finally {
		$('cap-start').disabled = !stats.tcpdump;
	}
});

function capFileName(c, ext) {
	const d = new Date(c.started * 1000);
	return (c.name || c.mac).replace(/[^\w.-]+/g, '_') + '_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
		'-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '.' + ext;
}

let capList = [];

async function refreshCapList() {
	try {
		const r = await dm('captureList');
		capList = r.captures || [];
	} catch (e) {
		return handleErr(e);
	}

	const box = $('cap-list');
	const now = Date.now() / 1000;
	const ids = new Set(capList.map((c) => c.id));

	for (const id in capItems)
		if (!ids.has(id)) {
			capItems[id].root.remove();
			delete capItems[id];
		}

	if (!capList.length) {
		box.replaceChildren(el('div', { class: 'empty-state', text: '还没有抓包记录' }));
		return;
	}
	box.querySelector('.empty-state')?.remove();

	capList.forEach((c, idx) => {
		let r = capItems[c.id];
		if (!r) {
			r = capItems[c.id] = {};
			r.title = el('div', { style: 'font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' });
			r.meta = el('div', { class: 'meta' });
			r.stop = el('button', { class: 'btn danger xs', text: '停止', onclick: () => stopCap(c.id) });
			r.root = el('div', { class: 'cap-item' }, [
				el('div', { style: 'min-width:0' }, [ r.title, r.meta ]),
				el('div', { class: 'acts' }, [
					r.stop,
					el('button', { class: 'btn ghost xs', text: '查看', onclick: () => live.open(c.id) }),
					el('button', { class: 'btn mint xs', text: 'pcap', title: '下载 pcap，用 Wireshark 打开', onclick: () => download(CAP_DIR + '/' + c.id + '.pcap', capFileName(c, 'pcap')) }),
					el('button', { class: 'btn ghost xs', text: '✕', title: '删除', onclick: () => deleteCap(c) })
				])
			]);
		}

		const elapsed = (c.running ? now : (c.ended || c.started)) - c.started;
		r.title.textContent = (c.running ? '🔴 ' : '') + (c.name || c.mac);
		r.title.title = c.mac;
		r.meta.textContent = fmtDateTime(c.started) + ' · ' + fmtDuration(elapsed) + ' · ' + fmtBytes(c.size) +
			(c.filter ? ' · ' + c.filter : '') + (c.error ? ' · 错误：' + c.error.split('\n')[0] : '');
		r.stop.classList.toggle('hidden', !c.running);
		r.root.classList.toggle('active', live.id == c.id);

		if (box.children[idx] !== r.root)
			box.insertBefore(r.root, box.children[idx] || null);
	});
}

async function stopCap(id) {
	try {
		await dm('captureStop', { id: id });
		toast('已停止抓包', 'ok');
		setTimeout(refreshCapList, 600);
	} catch (e) { handleErr(e); }
}

async function deleteCap(c) {
	const ok = await modal('删除抓包', el('p', { text: '删除「' + (c.name || c.mac) + ' ' + fmtDateTime(c.started) + '」的 pcap 和日志？' }),
		[ [ '取消', 'ghost', false ], [ '删除', 'danger', true ] ]);
	if (!ok)
		return;
	try {
		await dm('captureDelete', { id: c.id });
		if (live.id == c.id)
			live.reset();
		refreshCapList();
	} catch (e) { handleErr(e); }
}

/* ---------- 实时日志 ---------- */

// tcpdump -tttt 的一行：2026-11-02 16:37:00.123456 IP 1.2.3.4.5 > 6.7.8.9.53: ...
const LINE_RE = /^\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d\.\d{3})\d* (.*)$/;

function classify(t) {
	if (t.startsWith('ARP'))
		return 'arp';
	if (/ICMP/.test(t))
		return 'icmp';
	if (/\.53: |\.53 > |\.5353: /.test(t))
		return 'dns';
	if (/Flags \[/.test(t))
		return 'tcp';
	if (/UDP|\.(123|67|68|443|5353|1900): /.test(t))
		return 'udp';
	return 'oth';
}

const PROTO_LABEL = { tcp: 'TCP', udp: 'UDP', dns: 'DNS', icmp: 'ICMP', arp: 'ARP', oth: '其他' };

const live = {
	id: null,
	info: null,
	offset: 0,
	lines: [],
	total: 0,
	dropped: 0,
	hits: 0,
	paused: false,
	follow: true,
	timer: null,
	gen: 0,
	lastPkts: 0,
	lastTs: 0,
	pps: 0,
	protos: new Set([ 'tcp', 'udp', 'dns', 'icmp', 'arp', 'oth' ]),
	matcher: () => true,
	highlight: null,

	reset() {
		this.stopPolling();
		this.gen++;
		this.id = null;
		this.info = null;
		this.lines = [];
		this.total = this.dropped = this.hits = 0;
		$('console').replaceChildren(el('div', { class: 'empty', text: '点击左侧“开始抓包”，或在抓包记录里点“查看”' }));
		$('live-title').textContent = '未选择抓包';
		$('live-stop').classList.add('hidden');
		$('live-dl-pcap').disabled = $('live-dl-txt').disabled = true;
		for (const k of [ 'm-state', 'm-time', 'm-pkts', 'm-pps', 'm-size', 'm-hit' ])
			$(k).textContent = '-';
	},

	stopPolling() {
		clearTimeout(this.timer);
		this.timer = null;
	},

	async open(id) {
		this.reset();
		const gen = this.gen;
		this.id = id;
		this.info = capList.find((c) => c.id == id) || null;
		this.lastPkts = 0;
		this.lastTs = Date.now();
		$('console').replaceChildren();
		$('live-dl-pcap').disabled = $('live-dl-txt').disabled = false;
		document.querySelectorAll('.cap-item').forEach((n) => n.classList.remove('active'));
		capItems[id]?.root.classList.add('active');

		// 已结束的大文件只加载末尾，完整内容请下载
		const info = this.info;
		if (info && !info.running && info.txt_size > REPLAY_MAX_BYTES) {
			this.offset = info.txt_size - REPLAY_MAX_BYTES;
			this.skipPartial = true;
			this.notice('文件较大，只加载了最后 ' + fmtBytes(REPLAY_MAX_BYTES) + '，完整日志请点“下载完整日志”');
		}
		else {
			this.offset = 0;
			this.skipPartial = false;
		}

		await this.poll(gen);
	},

	notice(text) {
		$('console').append(el('div', { class: 'ln' }, el('span', { class: 'dim', text: '— ' + text + ' —' })));
	},

	async poll(gen) {
		if (gen != this.gen)
			return;
		let r;
		try {
			do {
				r = await dm('captureTail', { id: this.id, offset: this.offset, max: 65536 });
				if (gen != this.gen)
					return;
				if (r.error && !r.data)
					throw new Error(r.error);
				this.offset = r.offset;
				this.ingest(r.data || '');
			} while (r.more);
		} catch (e) {
			if (gen != this.gen)
				return;
			if (e instanceof AuthError)
				return handleErr(e);
			this.notice('读取失败：' + e.message);
			return;
		}

		this.updateMetrics(r);
		if (r.running)
			this.timer = setTimeout(() => this.poll(gen), 1000);
		else
			refreshCapList();
	},

	ingest(text) {
		if (!text)
			return;
		const raw = text.split('\n');
		raw.pop();
		if (this.skipPartial) {
			raw.shift();
			this.skipPartial = false;
		}

		const box = $('console');
		const frag = document.createDocumentFragment();

		for (const s of raw) {
			const m = LINE_RE.exec(s);
			const line = m ? { ts: m[1], t: m[2], raw: s } : { ts: '', t: s, raw: s };
			line.p = classify(line.t);
			// 筛选只匹配页面上看得到的内容，否则微秒数字也会被关键字命中
			line.view = line.ts + ' ' + line.t;
			this.lines.push(line);
			this.total++;
			if (this.match(line)) {
				this.hits++;
				if (!this.paused)
					frag.append(this.renderLine(line));
			}
		}

		while (this.lines.length > LIVE_MAX_LINES) {
			this.lines.shift();
			this.dropped++;
		}

		if (!this.paused && frag.childNodes.length) {
			box.querySelector('.empty')?.remove();
			box.append(frag);
			while (box.childElementCount > LIVE_MAX_DOM)
				box.firstElementChild.remove();
			if (this.follow)
				box.scrollTop = box.scrollHeight;
		}
		$('m-hit').textContent = this.hits;
	},

	match(line) {
		return this.protos.has(line.p) && this.matcher(line.view);
	},

	renderLine(line) {
		return el('div', { class: 'ln' }, [
			el('span', { class: 'ts', text: line.ts }),
			el('span', { class: 'pt p-' + line.p, text: PROTO_LABEL[line.p] }),
			this.highlighted(line.t)
		]);
	},

	highlighted(text) {
		const span = el('span', { class: 'tx', title: text });
		if (!this.highlight) {
			span.textContent = text;
			return span;
		}
		let last = 0;
		this.highlight.lastIndex = 0;
		for (const m of text.matchAll(this.highlight)) {
			if (!m[0])
				break;
			span.append(text.slice(last, m.index), el('mark', { text: m[0] }));
			last = m.index + m[0].length;
		}
		span.append(text.slice(last));
		return span;
	},

	// 关键字空格分隔、全部命中才显示，前缀 ! 表示排除；正则模式下整串当作正则
	setFilter() {
		const q = $('live-q').value.trim();
		const isRe = $('live-regex').classList.contains('on');
		const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		$('live-q').style.borderColor = '';

		if (!q) {
			this.matcher = () => true;
			this.highlight = null;
		}
		else if (isRe) {
			try {
				const re = new RegExp(q, 'i');
				this.matcher = (s) => re.test(s);
				this.highlight = new RegExp(q, 'gi');
			} catch (e) {
				$('live-q').style.borderColor = 'var(--rose)';
				return;
			}
		}
		else {
			const terms = q.toLowerCase().split(/\s+/);
			const inc = terms.filter((t) => !t.startsWith('!'));
			const exc = terms.filter((t) => t.startsWith('!') && t.length > 1).map((t) => t.slice(1));
			this.matcher = (s) => {
				s = s.toLowerCase();
				return inc.every((t) => s.includes(t)) && !exc.some((t) => s.includes(t));
			};
			this.highlight = inc.length ? new RegExp(inc.map(esc).join('|'), 'gi') : null;
		}
		this.rerender();
	},

	rerender() {
		const box = $('console');
		const matched = this.lines.filter((l) => this.match(l));
		this.hits = matched.length;
		$('m-hit').textContent = this.hits;
		if (!this.id)
			return;
		box.replaceChildren(...matched.slice(-LIVE_MAX_DOM).map((l) => this.renderLine(l)));
		if (!matched.length)
			box.append(el('div', { class: 'empty', text: this.lines.length ? '没有符合筛选条件的数据包' : '等待数据包…（设备有网络活动时才会出现）' }));
		box.scrollTop = box.scrollHeight;
	},

	updateMetrics(r) {
		const info = capList.find((c) => c.id == this.id) || this.info || {};
		const now = Date.now();
		const dt = (now - this.lastTs) / 1000;
		if (dt >= .8) {
			this.pps = Math.max(0, (this.total - this.lastPkts) / dt);
			this.lastPkts = this.total;
			this.lastTs = now;
		}
		const ended = r.running ? null : (info.ended || now / 1000);
		$('live-title').textContent = (info.name || info.mac || '') + (info.filter ? '  · ' + info.filter : '');
		$('m-state').innerHTML = '';
		$('m-state').append(r.running
			? el('span', { style: 'color:var(--rose)', text: '● 抓包中' })
			: el('span', { style: 'color:var(--mint)', text: r.error ? '✕ 出错' : '✓ 已完成' }));
		$('m-time').textContent = info.started ? fmtDuration((ended || now / 1000) - info.started) : '-';
		$('m-pkts').textContent = this.total;
		$('m-pps').textContent = r.running ? this.pps.toFixed(1) + '/s' : '-';
		$('m-size').textContent = fmtBytes(r.size);
		$('live-stop').classList.toggle('hidden', !r.running);
		if (!this.total && !this.paused && !$('console').childElementCount)
			$('console').append(el('div', { class: 'empty', text: r.running ? '等待数据包…（设备有网络活动时才会出现）' : '这次抓包没有抓到数据包' }));
		if (r.error)
			this.notice('tcpdump：' + r.error);
	}
};

let qTimer = null;
$('live-q').addEventListener('input', () => {
	clearTimeout(qTimer);
	qTimer = setTimeout(() => live.setFilter(), 200);
});
$('live-regex').addEventListener('click', (e) => {
	e.currentTarget.classList.toggle('on');
	live.setFilter();
});
document.querySelectorAll('[data-p]').forEach((c) => c.addEventListener('click', () => {
	c.classList.toggle('on');
	live.protos[c.classList.contains('on') ? 'add' : 'delete'](c.dataset.p);
	live.rerender();
}));
$('live-follow').addEventListener('click', (e) => {
	live.follow = !live.follow;
	e.currentTarget.textContent = live.follow ? '⇩ 自动滚动' : '⇩ 已停止滚动';
	if (live.follow)
		$('console').scrollTop = $('console').scrollHeight;
});
$('live-pause').addEventListener('click', (e) => {
	live.paused = !live.paused;
	e.currentTarget.textContent = live.paused ? '▶ 继续' : '❚❚ 暂停';
	if (!live.paused)
		live.rerender();
});
$('live-clear').addEventListener('click', () => {
	live.lines = [];
	live.hits = 0;
	$('console').replaceChildren();
	$('m-hit').textContent = '0';
});
$('live-save').addEventListener('click', () => {
	if (!live.id)
		return;
	const c = capList.find((x) => x.id == live.id) || { mac: 'capture', started: Date.now() / 1000 };
	const text = live.lines.filter((l) => live.match(l)).map((l) => l.raw).join('\n') + '\n';
	saveText(text, capFileName(c, 'filtered.txt'));
});
$('live-stop').addEventListener('click', () => live.id && stopCap(live.id));
$('live-dl-pcap').addEventListener('click', () => {
	const c = capList.find((x) => x.id == live.id);
	if (c)
		download(CAP_DIR + '/' + c.id + '.pcap', capFileName(c, 'pcap'));
});
$('live-dl-txt').addEventListener('click', () => {
	const c = capList.find((x) => x.id == live.id);
	if (c)
		download(CAP_DIR + '/' + c.id + '.txt', capFileName(c, 'txt'));
});

/* ---------- 设置 ---------- */

async function loadSettings() {
	try {
		const r = await ubus('uci', 'get', { config: 'devmon', section: 'main' });
		const v = r.values || {};
		$('set-enabled').checked = v.enabled != '0';
		$('set-iface').replaceChildren(...(stats.ifaces || [ 'br-lan' ]).map((n) => el('option', { value: n, text: n })));
		$('set-iface').value = v.iface || 'br-lan';
		$('set-interval').value = v.interval || '2';
		$('set-history').value = v.history || '150';
		$('set-capmax').value = v.cap_max_mb || '64';
	} catch (e) { handleErr(e); }
}

$('set-save').addEventListener('click', async () => {
	const msg = $('set-msg');
	const history = Math.min(1800, Math.max(10, +$('set-history').value || 150));
	const capmax = Math.min(1024, Math.max(1, +$('set-capmax').value || 64));
	try {
		await ubus('uci', 'set', { config: 'devmon', section: 'main', values: {
			enabled: $('set-enabled').checked ? '1' : '0',
			iface: $('set-iface').value,
			interval: $('set-interval').value,
			history: String(history),
			cap_max_mb: String(capmax)
		} });
		await ubus('uci', 'commit', { config: 'devmon' });
		msg.className = 'msg ok';
		msg.textContent = '✓ 已保存，几秒内生效';
		setTimeout(refreshStats, 1500);
	} catch (e) {
		if (e instanceof AuthError)
			return handleErr(e);
		msg.className = 'msg err';
		msg.textContent = '保存失败：' + e.message;
	}
});

/* ---------- 标签页 ---------- */

function switchTab(name) {
	tab = name;
	document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab == name));
	document.querySelectorAll('[data-page]').forEach((p) => p.classList.toggle('hidden', p.dataset.page != name));
	try { sessionStorage.setItem('devmon_tab', name); } catch (e) {}

	clearInterval(capListTimer);
	capListTimer = null;

	if (name == 'overview')
		renderOverview().catch(handleErr);
	else if (name == 'devices') {
		devOrderSig = '';
		renderDevices();
	}
	else if (name == 'capture') {
		syncCaptureForm();
		refreshCapList();
		capListTimer = setInterval(refreshCapList, 2000);
	}
	else if (name == 'settings')
		loadSettings();
}

$('tabs').addEventListener('click', (e) => {
	const b = e.target.closest('button[data-tab]');
	if (b)
		switchTab(b.dataset.tab);
});

/* ---------- 启动 ---------- */

(async () => {
	// 从 LuCI 打开时会在 #sid= 里带上当前会话，免二次登录；读完立即从地址栏去掉
	// #tab= 可以直接打开指定标签页，方便收藏
	const m = /[#&]sid=([0-9a-f]{32})/.exec(location.hash);
	const t = /[#&]tab=(overview|devices|capture|settings)/.exec(location.hash);
	if (m)
		history.replaceState(null, '', location.pathname + (t ? '#tab=' + t[1] : ''));
	try {
		sid = m ? m[1] : sessionStorage.getItem(SID_KEY);
		tab = t ? t[1] : (sessionStorage.getItem('devmon_tab') || 'overview');
	} catch (e) {}

	// 在已打开的页面里粘贴带 #sid= 的链接只会改变 hash，不会重新加载，这里手动重新走一遍启动流程
	window.addEventListener('hashchange', () => {
		if (/[#&]sid=/.test(location.hash))
			location.reload();
	});

	if (!sid)
		return showLogin();
	try {
		await dm('getStats');
		enterApp();
	} catch (e) {
		showLogin(e instanceof AuthError ? '' : '无法连接路由器：' + e.message);
	}
})();

})();

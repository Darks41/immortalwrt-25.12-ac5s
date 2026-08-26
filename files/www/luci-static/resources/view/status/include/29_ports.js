'use strict';
'require baseclass';
'require fs';
'require ui';
'require uci';
'require rpc';
'require network';
'require firewall';

const callGetBuiltinEthernetPorts = rpc.declare({
	object: 'luci',
	method: 'getBuiltinEthernetPorts',
	expect: { result: [] }
});

const callNetworkDeviceStatus = rpc.declare({
	object: 'network.device',
	method: 'status',
	params: ['name'],
	expect: { '': {} }
});

const callGetSwconfigMib = rpc.declare({
	object: 'ac5s',
	method: 'getSwconfigMib',
	params: ['port'],
	expect: { result: {} }
});

function isString(v) {
	return typeof(v) === 'string' && v !== '';
}

function resolveVLANChain(ifname, bridges, mapping) {
	while (!mapping[ifname]) {
		const m = ifname.match(/^(.+)\.([^.]+)$/);
		if (!m)
			break;

		if (bridges[m[1]]) {
			if (bridges[m[1]].vlan_filtering)
				mapping[ifname] = bridges[m[1]].vlans[m[2]];
			else
				mapping[ifname] = bridges[m[1]].ports;
		}
		else if (/^[0-9]{1,4}$/.test(m[2]) && m[2] <= 4095) {
			mapping[ifname] = [m[1]];
		}
		else {
			break;
		}

		ifname = m[1];
	}
}

function buildVLANMappings(mapping) {
	const bridge_vlans = uci.sections('network', 'bridge-vlan');
	const vlan_devices = uci.sections('network', 'device');
	const interfaces = uci.sections('network', 'interface');
	const bridges = {};

	for (let i = 0, s; (s = bridge_vlans[i]) != null; i++) {
		if (!isString(s.device) || !/^[0-9]{1,4}$/.test(s.vlan) || +s.vlan > 4095)
			continue;

		const aliases = L.toArray(s.alias);
		const ports = L.toArray(s.ports);
		const br = bridges[s.device] = (bridges[s.device] || { ports: [], vlans: {}, vlan_filtering: true });

		br.vlans[s.vlan] = [];

		for (let p of ports) {
			const port = p.replace(/:[ut*]+$/, '');
			if (br.ports.indexOf(port) === -1)
				br.ports.push(port);
			br.vlans[s.vlan].push(port);
		}

		for (let a of aliases)
			if (a != s.vlan)
				br.vlans[a] = br.vlans[s.vlan];
	}

	for (let i = 0, s; (s = vlan_devices[i]) != null; i++) {
		if (s.type == 'bridge') {
			if (!isString(s.name))
				continue;

			const ports = L.toArray(s.ports);
			const br = bridges[s.name] || (bridges[s.name] = { ports: [], vlans: {}, vlan_filtering: false });

			if (s.vlan_filtering == '0')
				br.vlan_filtering = false;
			else if (s.vlan_filtering == '1')
				br.vlan_filtering = true;

			for (let p of ports)
				if (br.ports.indexOf(p) === -1)
					br.ports.push(p);

			mapping[s.name] = br.ports;
		}
		else if (s.type == '8021q' || s.type == '8021ad') {
			if (!isString(s.name) || !isString(s.vid) || !isString(s.ifname))
				continue;

			if (bridges[s.ifname]) {
				if (bridges[s.ifname].vlan_filtering)
					mapping[s.name] = bridges[s.ifname].vlans[s.vid];
				else
					mapping[s.name] = bridges[s.ifname].ports;
			}
			else {
				mapping[s.name] = [s.ifname];
			}

			resolveVLANChain(s.ifname, bridges, mapping);
		}
	}

	for (let brname in bridges) {
		for (let bp of bridges[brname].ports)
			resolveVLANChain(bp, bridges, mapping);

		for (let vid in bridges[brname].vlans)
			for (let v of bridges[brname].vlans[vid])
				resolveVLANChain(v, bridges, mapping);
	}

	for (let i = 0, s; (s = interfaces[i]) != null; i++) {
		if (!isString(s.device))
			continue;

		resolveVLANChain(s.device, bridges, mapping);
	}
}

function resolveVLANPorts(ifname, mapping, seen) {
	const ports = [];

	if (!seen)
		seen = {};

	if (mapping[ifname]) {
		for (let m of mapping[ifname]) {
			if (!seen[m]) {
				seen[m] = true;
				ports.push.apply(ports, resolveVLANPorts(m, mapping, seen));
			}
		}
	}
	else {
		ports.push(ifname);
	}

	return ports.sort(L.naturalCompare);
}

function buildInterfaceMapping(zones, networks) {
	const vlanmap = {};
	const portmap = {};
	const netmap = {};

	buildVLANMappings(vlanmap);

	for (let net of networks) {
		const l3dev = net.getDevice();
		if (!l3dev)
			continue;

		const ports = resolveVLANPorts(l3dev.getName(), vlanmap);

		for (let p of ports) {
			portmap[p] = portmap[p] || { networks: [], zones: [] };
			portmap[p].networks.push(net);
		}

		netmap[net.getName()] = net;
	}

	for (let z of zones) {
		const networknames = z.getNetworks();

		for (let nn of networknames) {
			if (!netmap[nn])
				continue;

			const l3dev = netmap[nn].getDevice();
			if (!l3dev)
				continue;

			const ports = resolveVLANPorts(l3dev.getName(), vlanmap);

			for (let p of ports) {
				portmap[p] = portmap[p] || { networks: [], zones: [] };

				if (portmap[p].zones.indexOf(z) === -1)
					portmap[p].zones.push(z);
			}
		}
	}

	return portmap;
}

function formatSpeed(carrier, speed, duplex) {
	if ((speed > 0) && duplex) {
		const d = (duplex == 'half') ? '\u202f(H)' : '';
		const e = E('span', { 'title': _('Speed: %d Mbit/s, Duplex: %s').format(speed, duplex) });

		switch (true) {
			case (speed < 1000):
				e.innerText = '%d\u202fM%s'.format(speed, d);
				break;
			case (speed == 1000):
				e.innerText = '1\u202fGbE' + d;
				break;
			case (speed >= 1e6 && speed < 1e9):
				e.innerText = '%f\u202fTbE'.format(speed / 1e6);
				break;
			case (speed >= 1e9):
				e.innerText = '%f\u202fPbE'.format(speed / 1e9);
				break;
			default:
				e.innerText = '%f\u202fGbE'.format(speed / 1000);
		}

		return e;
	}

	return carrier ? _('Connected') : _('no link');
}

function getPSEStatus(pse) {
	if (!pse)
		return null;

	const status = pse['c33-power-status'] || pse['podl-power-status'],
	      power = pse['c33-actual-power'];

	return { status: status, power: power, isDelivering: status === 'delivering' && power > 0 };
}

function formatPSEPower(pse) {
	if (!pse)
		return null;

	const status = pse['c33-power-status'] || pse['podl-power-status'],
	      power = pse['c33-actual-power'];

	if (status === 'delivering' && power) {
		const watts = (power / 1000).toFixed(1);
		return E('span', { 'style': 'color:#000' }, ['\u26a1\ufe0f\u202f%s\u202fW'.format(watts)]);
	}
	else if (status === 'searching') {
		return E('span', { 'style': 'color:#000' }, ['\u26a1\ufe0f\u202f' + _('searching')]);
	}
	else if (status === 'fault' || status === 'otherfault' || status === 'error') {
		return E('span', { 'style': 'color:#d9534f' }, ['\u26a1\ufe0f\u202f' + _('fault')]);
	}
	else if (status === 'disabled') {
		return E('span', { 'style': 'color:#888' }, ['\u26a1\ufe0f\u202f' + _('off')]);
	}

	return null;
}

function formatStats(portdev, pse) {
	const stats = portdev._devstate('stats') || {};
	const items = [
		_('Received bytes'), '%1024mB'.format(stats.rx_bytes),
		_('Received packets'), '%1000mPkts.'.format(stats.rx_packets),
		_('Received multicast'), '%1000mPkts.'.format(stats.multicast),
		_('Receive errors'), '%1000mPkts.'.format(stats.rx_errors),
		_('Receive dropped'), '%1000mPkts.'.format(stats.rx_dropped),
		_('Transmitted bytes'), '%1024mB'.format(stats.tx_bytes),
		_('Transmitted packets'), '%1000mPkts.'.format(stats.tx_packets),
		_('Transmit errors'), '%1000mPkts.'.format(stats.tx_errors),
		_('Transmit dropped'), '%1000mPkts.'.format(stats.tx_dropped),
		_('Collisions seen'), stats.collisions
	];

	if (pse) {
		const status = pse['c33-power-status'] || pse['podl-power-status'],
		      power = pse['c33-actual-power'],
		      powerClass = pse['c33-power-class'],
		      powerLimit = pse['c33-available-power-limit'];

		items.push(_('PoE status'), status || _('unknown'));

		if (power)
			items.push(_('PoE power'), '%.1f W'.format(power / 1000));

		if (powerClass)
			items.push(_('PoE class'), powerClass);

		if (powerLimit)
			items.push(_('PoE limit'), '%.1f W'.format(powerLimit / 1000));
	}

	return ui.itemlist(E('span'), items);
}

// Build the hover tooltip from the physical-port MIB counters (authoritative
// per-port traffic, includes frames forwarded inside the switch that never
// reach the CPU). Mirrors the field layout of formatStats() for consistency.
function formatMibStats(mib) {
	const rxp = (mib.ifInUcastPkts || 0) + (mib.ifInMulticastPkts || 0) + (mib.ifInBroadcastPkts || 0);
	const txp = (mib.ifOutUcastPkts || 0) + (mib.ifOutMulticastPkts || 0) + (mib.ifOutBroadcastPkts || 0);

	return ui.itemlist(E('span'), [
		_('Received bytes'), '%1024mB'.format(mib.ifInOctets || 0),
		_('Received packets'), '%1000mPkts.'.format(rxp),
		_('Received multicast'), '%1000mPkts.'.format(mib.ifInMulticastPkts || 0),
		_('Transmitted bytes'), '%1024mB'.format(mib.ifOutOctets || 0),
		_('Transmitted packets'), '%1000mPkts.'.format(txp),
		_('Transmitted multicast'), '%1000mPkts.'.format(mib.ifOutMulticastPkts || 0),
		_('Transmit dropped'), '%1000mPkts.'.format(mib.ifOutDiscards || 0)
	]);
}

// Transparent secondary reference: the interface-layer (CPU-visible) counter
// for the logical device this physical port belongs to, i.e. the value the
// "Network > Interfaces" page reports for that interface. Physical-port MIB
// traffic is normally larger because the switch forwards frames between LAN
// ports without going through the CPU (and, for sfp_wan, because the physical
// port also carries PPPoE/management frames). This shows that difference
// instead of hiding it.
function formatNetdevReference(netdev) {
	if (!netdev)
		return null;

	const rx = netdev.getRXBytes();
	const tx = netdev.getTXBytes();

	if (typeof rx !== 'number' || typeof tx !== 'number')
		return null;

	return E('span', {
		'style': 'display:block;margin-top:.5em;padding-top:.25em;border-top:1px dotted #666;color:#999',
		'title': _('Interface-layer counter (as shown in "Network > Interfaces")')
	}, [
		E('strong', _('Interface layer (%s)').format(netdev.getName())),
		E('br'),
		'\u25b2\u202f%1024.1mB'.format(tx),
		E('br'),
		'\u25bc\u202f%1024.1mB'.format(rx)
	]);
}

function renderNetworkBadge(network, zonename) {
	const l3dev = network.getDevice();
	const span = E('span', { 'class': 'ifacebadge', 'style': 'margin:.125em 0' }, [
		E('span', {
			'class': 'zonebadge',
			'title': zonename ? _('Part of zone %q').format(zonename) : _('No zone assigned'),
			'style': firewall.getZoneColorStyle(zonename)
		}, '\u202f'),
		'\u202f', network.getName(), ': '
	]);

	if (l3dev)
		span.appendChild(E('img', { 'title': l3dev.getI18n(), 'src': L.resource('icons/%s%s.svg'.format(l3dev.getType(), l3dev.isUp() ? '' : '_disabled')) }));
	else
		span.appendChild(E('em', _('(no interfaces attached)')));

	return span;
}

function renderNetworksTooltip(pmap) {
	const res = [null];
	const zmap = {};
	const zones = (pmap && Array.isArray(pmap.zones)) ? pmap.zones : [];
	const networks = (pmap && Array.isArray(pmap.networks)) ? pmap.networks : [];

	for (let pmz of zones) {
		const networknames = pmz.getNetworks();
		for (let nn of networknames)
			zmap[nn] = pmz.getName();
	}

	for (let pmn of networks)
		res.push(E('br'), renderNetworkBadge(pmn, zmap[pmn.getName()]));

	if (res.length > 1)
		res[0] = N_((res.length - 1) / 2, 'Part of network:', 'Part of networks:');
	else
		res[0] = _('Port is not part of any network');

	return E([], res);
}

return baseclass.extend({
	title: _('Port status'),

	load() {
		return Promise.all([
			L.resolveDefault(callGetBuiltinEthernetPorts(), []),
			fs.read('/etc/board.json', '{}'),
			firewall.getZones(),
			network.getNetworks(),
			uci.load('network')
		]).then((data) => {
			const builtinPorts = data[0] || [];
			const board = JSON.parse(data[1] || '{}');
			const allPorts = new Set();

			builtinPorts.forEach((port) => {
				if (port.device)
					allPorts.add(port.device);
			});

			if (allPorts.size === 0 && board.network) {
				['lan', 'wan'].forEach((role) => {
					if (board.network[role]) {
						if (Array.isArray(board.network[role].ports))
							board.network[role].ports.forEach((p) => allPorts.add(p));
						else if (board.network[role].device)
							allPorts.add(board.network[role].device);
					}
				});
			}

			if (board && board.model && board.model.id === 'beeconmini,seed-ac5s')
				['eth0', 'eth1.2', 'eth1.1'].forEach((d) => allPorts.add(d));

			const psePromises = Array.from(allPorts).map((devname) => {
				return L.resolveDefault(callNetworkDeviceStatus(devname), {}).then((status) => {
					return { name: devname, pse: status.pse || null };
				});
			});

			return Promise.all(psePromises).then((pseResults) => {
				const pseMap = {};

				pseResults.forEach((r) => {
					if (r.pse)
						pseMap[r.name] = r.pse;
				});

				data.push(pseMap);

				return Promise.all((board && board.model && board.model.id === 'beeconmini,seed-ac5s') ? [0, 1, 2, 3, 4, 5, 6, 8].map((p) => L.resolveDefault(callGetSwconfigMib(p), {})) : []).then((mibs) => {
					const mibMap = {};

					mibs.forEach((m, i) => {
						if (m && (m.link != null || m.ifInOctets != null))
							mibMap[[0, 1, 2, 3, 4, 5, 6, 8][i]] = m;
					});

					data.push(mibMap);
					return data;
				});
			});
		});
	},

	render(data) {
		const board = JSON.parse(data[1]),
		      port_map = buildInterfaceMapping(data[2], data[3]),
		      pseMap = data[5] || {};

		let known_ports = [];

		if (Array.isArray(data[0]) && data[0].length > 0) {
			known_ports = data[0].map(port => ({ ...port, netdev: network.instantiateDevice(port.device) }));
		}
		else {
			if (L.isObject(board) && L.isObject(board.network)) {
				for (let k = 'lan'; k != null; k = (k == 'lan') ? 'wan' : null) {
					if (!L.isObject(board.network[k]))
						continue;

					if (Array.isArray(board.network[k].ports))
						for (let i = 0; i < board.network[k].ports.length; i++)
							known_ports.push({ role: k, device: board.network[k].ports[i], netdev: network.instantiateDevice(board.network[k].ports[i]) });
					else if (typeof(board.network[k].device) == 'string')
						known_ports.push({ role: k, device: board.network[k].device, netdev: network.instantiateDevice(board.network[k].device) });
				}
			}
		}

		if (board && board.model && board.model.id === 'beeconmini,seed-ac5s') {
			const zmap = {}, nmap = {};

			(data[2] || []).forEach((z) => { zmap[z.getName()] = z; });
			(data[3] || []).forEach((n) => { nmap[n.getName()] = n; });

			const zonenets = (zs) => {
				const seen = {}, arr = [];

				zs.forEach((zn) => {
					const z = zmap[zn];
					if (!z)
						return;

					(z.getNetworks && z.getNetworks()).forEach((nn) => {
						const n = nmap[nn];
						if (n && !seen[nn]) {
							seen[nn] = 1;
							arr.push(n);
						}
					});
				});

				return arr;
			};

			const mkpmap = (zs) => ({ networks: zonenets(zs), zones: zs.map((z) => zmap[z]).filter(Boolean) });

			// Physical-port -> logical-interface reference netdev (transparent
			// CPU-layer counter, matching the "Network > Interfaces" page).
			const swlan = [
				['lan2', 6], ['lan3', 5], ['lan4', 4], ['lan5', 3], ['lan6', 2], ['lan7', 1], ['lan8', 0]
			];

			// Interface-layer reference for the EN8811H WAN: the L3 device the
			// "Network > Interfaces" page reports for the 'wan' interface. With
			// DHCP/static this is eth0 itself (identical to the physical-port
			// counter); if 'wan' is switched to PPPoE it resolves to the
			// pppoe-wan session instead, mirroring sfp_wan. Falls back to eth0
			// when no 'wan' network is defined.
			const wanNet = nmap['wan'];
			const wanRef = (wanNet && wanNet.getDevice) ? wanNet.getDevice() : null;

			known_ports = [
				{ role: 'wan', title: 'wan', device: 'eth0', zone: 'wan', netdev: network.instantiateDevice('eth0'),
				  refnetdev: wanRef || network.instantiateDevice('eth0'), pmap: mkpmap(['wan']) }
			];

			for (let i = 0; i < swlan.length; i++)
				known_ports.push({
					role: 'lan',
					title: swlan[i][0],
					device: swlan[i][0],
					zone: 'lan',
					mibPort: swlan[i][1],
					refnetdev: network.instantiateDevice('br-lan'),
					netdev: null,
					pmap: mkpmap(['lan'])
				});

			known_ports.push({
				role: 'sfp_wan',
				title: 'sfp_wan',
				device: 'eth1.2',
				zone: 'wan',
				mibPort: 8,
				// Interface-layer reference: the L3 device the "Network > Interfaces"
				// page reports for sfp_wan. For a PPPoE session this is pppoe-sfp_wan;
				// formatNetdevReference() silently omits the block when the device is
				// not present (e.g. PPPoE not up), instead of showing wrong data.
				refnetdev: network.instantiateDevice('pppoe-sfp_wan'),
				netdev: network.instantiateDevice('eth1.2'),
				pmap: mkpmap(['wan'])
			});
		}

		known_ports.sort(function(a, b) {
			return L.naturalCompare(a.title || a.device, b.title || b.device);
		});

		return E('div', {
			'style': 'display:grid;grid-template-columns:repeat(auto-fit, minmax(100px, 1fr));margin-bottom:1em;align-items:center;justify-items:center;text-align:center'
		}, known_ports.map(function(port) {
			const mibMap = data[6] || {};
			const mib = (port.mibPort != null) ? (mibMap[port.mibPort] || null) : null;
			const carrier = (port.mibPort != null) ? (mib && mib.link === 'up') : (port.netdev ? port.netdev.getCarrier() : false);

			const pmap = port.pmap || ((port.netdev) ? port_map[port.netdev.getName()] : null);
			const pzones = (pmap && pmap.zones && pmap.zones.length) ? pmap.zones.sort((a, b) => L.naturalCompare(a.getName(), b.getName())) : [null];

			const pse = pseMap[port.device];
			const pseInfo = getPSEStatus(pse);
			const psePower = formatPSEPower(pse);

			let portIcon;
			if (pseInfo && pseInfo.isDelivering)
				portIcon = carrier ? 'pse_up' : 'pse_down';
			else
				portIcon = carrier ? 'up' : 'down';

			let mibTX = null, mibRX = null;
			if (port.mibPort != null && mib) {
				mibTX = mib.ifOutOctets || 0;
				mibRX = mib.ifInOctets || 0;
			}

			const txv = (mibTX != null) ? mibTX : (port.netdev ? port.netdev.getTXBytes() : 0);
			const rxv = (mibRX != null) ? mibRX : (port.netdev ? port.netdev.getRXBytes() : 0);

			const statsContent = [
				'\u25b2\u202f%1024.1mB'.format(txv),
				E('br'),
				'\u25bc\u202f%1024.1mB'.format(rxv)
			];

			if (psePower) {
				statsContent.push(E('br'));
				statsContent.push(psePower);
			}

			// Hover tooltip. Physical-port MIB is authoritative (constant display
			// and tooltip come from the same source, so they always agree). For
			// ports without a switch port (e.g. the EN8811H WAN), fall back to the
			// netdev counters. A transparent CPU-layer reference is appended so the
			// physical-vs-interface difference is visible instead of hidden - also
			// for the WAN card, where the reference is the 'wan' interface's L3
			// device (eth0 for DHCP/static, pppoe-wan for PPPoE).
			if (port.mibPort != null && mib) {
				statsContent.push(E('span', { 'class': 'cbi-tooltip' }, [
					formatMibStats(mib),
					formatNetdevReference(port.refnetdev || port.netdev)
				]));
			}
			else if (port.netdev) {
				const ref = formatNetdevReference(port.refnetdev);
				statsContent.push(E('span', { 'class': 'cbi-tooltip' }, (ref != null) ? [formatStats(port.netdev, pse), ref] : formatStats(port.netdev, pse)));
			}

			let spd = 0, dpx = null;
			if (port.mibPort != null && mib) {
				const sk = mib.speed;
				spd = (sk && /^\d+$/.test(String(sk))) ? parseInt(sk, 10) : 0;
				dpx = mib.duplex;
			}
			else if (port.netdev) {
				spd = port.netdev.getSpeed();
				dpx = port.netdev.getDuplex();
			}

			const speedLabel = formatSpeed(carrier, spd, dpx);

			return E('div', {
				'class': 'ifacebox',
				'style': 'margin:.25em;width:100px'
			}, [
				E('div', { 'class': 'ifacebox-head', 'style': 'font-weight:bold' }, [port.title || (port.netdev ? port.netdev.getName() : '')]),
				E('div', { 'class': 'ifacebox-body' }, [
					E('img', { 'src': L.resource('icons/port_%s.svg').format(portIcon) }),
					E('br'),
					speedLabel
				]),
				E('div', { 'class': 'ifacebox-head cbi-tooltip-container', 'style': 'display:flex' }, [
					E([], pzones.map(function(zone) {
						return E('div', {
							'class': 'zonebadge',
							'style': 'cursor:help;flex:1;height:3px;opacity:' + (carrier ? 1 : 0.25) + ';' + firewall.getZoneColorStyle(zone)
						});
					})),
					E('span', { 'class': 'cbi-tooltip left' }, [renderNetworksTooltip(pmap)])
				]),
				E('div', { 'class': 'ifacebox-body' }, [
					E('div', { 'class': 'cbi-tooltip-container', 'style': 'text-align:left;font-size:80%' }, statsContent)
				])
			]);
		}));
	}
});

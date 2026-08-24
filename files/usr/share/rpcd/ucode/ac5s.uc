// BeeconMini SEED AC5S: expose RTL8373N per-port MIB counters to LuCI
// (used by the port-status page to show real physical-port traffic,
//  including switch-internal forwarding that never reaches the CPU)
// Copyright 2026 AC5S integration
// Licensed to the public under the Apache License 2.0.

'use strict';

import { popen } from 'fs';

return {
	ac5s: {
		getSwconfigMib: {
			args: { port: 0 },
			call: function(request) {
				const p = int(request.args.port);
				let res = {};

				// Per-port link status (drives the up/down icon and the zone
				// status bar on the LuCI port-status page).
				const lnk = popen(`swconfig dev switch0 port ${p} get link 2>&1`);
				if (lnk) {
					let l = lnk.read('line');
					let m = match(l, /link:(\S+)/);
					if (m)
						res.link = m[1];
					m = match(l, /speed:(\S+)/);
					if (m)
						res.speed = m[1];
					let d = match(l, /(\w+)-duplex/);
					if (d)
						res.duplex = d[1];
					lnk.close();
				}

				const swc = popen(`swconfig dev switch0 port ${p} get mib 2>&1`);
				if (swc) {
					for (let line = swc.read('line'); length(line); line = swc.read('line')) {
						let m = match(line, /^(ifInOctets|ifOutOctets|ifInUcastPkts|ifOutUcastPkts|ifInMulticastPkts|ifOutMulticastPkts|ifInBroadcastPkts|ifOutBroadcastPkts)\s*:\s*(\d+)/);

						if (m)
							res[m[1]] = int(m[2]);
					}

					swc.close();
				}

				return { result: res };
			}
		}
	}
};

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
				const swc = popen(`swconfig dev switch0 port ${int(request.args.port)} get mib 2>&1`);
				let res = {};

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

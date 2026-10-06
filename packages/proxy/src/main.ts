// The proxy: node packages/proxy/dist/main.js
import { runApp } from '@servicerouter/common';

import { startProxy } from './start.js';

await runApp({ name: 'proxy', start: startProxy });

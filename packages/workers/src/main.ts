// Workers: node packages/workers/dist/main.js
import { runApp } from '@servicerouter/common';

import { startWorkers } from './start.js';

await runApp({ name: 'workers', start: startWorkers });

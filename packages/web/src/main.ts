// The website: node packages/web/dist/main.js
import { runApp } from '@servicerouter/common';

import { startWeb } from './start.js';

await runApp({ name: 'web', start: startWeb });

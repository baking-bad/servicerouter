import { describe } from 'vitest';

import { describeIsolation } from './isolation.js';

describe('test file isolation, file A', () => describeIsolation('file-a'));

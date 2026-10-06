import { platformGuide } from '../../src/agents/guide';
import { textResponse } from '../../src/agents/text';
import { readSettings } from '../../src/config';

export const dynamic = 'force-dynamic';

// AD-5: the platform guide for first-time buyers (WB-11)
export const GET = (): Response => textResponse(platformGuide(readSettings()), 'text/plain');

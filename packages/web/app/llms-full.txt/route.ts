import { fullDocument } from '../../src/agents/full';
import { textResponse } from '../../src/agents/text';
import { listAllCatalog } from '../../src/api/catalog';
import { readSettings } from '../../src/config';

export const dynamic = 'force-dynamic';

// WB-11: the guide, both skills, and the catalog in one file
export const GET = async (): Promise<Response> => {
  const settings = readSettings();

  return textResponse(fullDocument(settings, await listAllCatalog(settings)), 'text/plain');
};

import { findSkill, skillDocument } from '../../../../src/agents/skills';
import { textResponse } from '../../../../src/agents/text';
import { readSettings } from '../../../../src/config';

export const dynamic = 'force-dynamic';

// AD-5, AD-7: the platform Agent Skills (WB-11)
export const GET = async (_request: Request, { params }: { readonly params: Promise<{ readonly name: string }> }): Promise<Response> => {
  const skill = findSkill((await params).name);

  return skill
    ? textResponse(skillDocument(skill, readSettings()), 'text/markdown')
    : new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

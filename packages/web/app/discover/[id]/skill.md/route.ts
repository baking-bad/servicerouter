import { serviceSkill } from '../../../../src/agents/serviceDocs';
import { serviceDocument } from '../../../../src/agents/serviceRoute';

export const dynamic = 'force-dynamic';

// AD-2, served by the website while it is sample data (WB-10)
export const GET = async (_request: Request, { params }: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> =>
  serviceDocument((await params).id, (service, siteUrl) => ({ body: serviceSkill(service, siteUrl), contentType: 'text/markdown; charset=utf-8' }));

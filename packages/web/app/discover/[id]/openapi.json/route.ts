import { serviceOpenApi } from '../../../../src/agents/serviceDocs';
import { serviceDocument } from '../../../../src/agents/serviceRoute';

export const dynamic = 'force-dynamic';

// AD-1, served by the website while it is sample data (WB-10)
export const GET = async (_request: Request, { params }: { readonly params: Promise<{ readonly id: string }> }): Promise<Response> =>
  serviceDocument((await params).id, service => ({ body: `${JSON.stringify(serviceOpenApi(service), null, 2)}\n`, contentType: 'application/json; charset=utf-8' }));

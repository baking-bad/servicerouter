// Plain text and Markdown answers for agents: UTF-8, cached briefly, and always the same per settings.

export const textResponse = (body: string, contentType: 'text/plain' | 'text/markdown'): Response =>
  new Response(body, { headers: { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'public, max-age=300' } });

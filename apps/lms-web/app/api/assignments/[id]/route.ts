const API_GATEWAY = process.env['API_GATEWAY_INTERNAL_URL'] ?? 'http://localhost:4000';

type Ctx = { params: Promise<{ id: string }> };

async function proxy(request: Request, id: string): Promise<Response> {
  const method = request.method;
  const cookie = request.headers.get('cookie') ?? '';
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);

  const bodyText = hasBody ? await request.text() : undefined;

  const res = await fetch(`${API_GATEWAY}/assignments/${id}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(bodyText !== undefined ? { body: bodyText } : {}),
  });

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export async function GET(req: Request, { params }: Ctx) {
  return proxy(req, (await params).id);
}
export async function PATCH(req: Request, { params }: Ctx) {
  return proxy(req, (await params).id);
}
export async function DELETE(req: Request, { params }: Ctx) {
  return proxy(req, (await params).id);
}

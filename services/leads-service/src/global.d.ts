export {};

declare module 'fastify' {
  interface FastifyRequest {
    auth: {
      org_id: string;
      user_id: string;
      role: string;
      tenant_id: string;
      rank: number;
    };
  }
}

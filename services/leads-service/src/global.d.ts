export {};

declare module 'fastify' {
  interface FastifyRequest {
    auth: {
      org_id: string;
      user_id: string;
      /** platform_role — drives withRoleTx's PG-role selection (RLS) and the
       *  cross-org (super_admin/tenant_admin) gates. */
      role: string;
      tenant_id: string;
      /** Unified iam ladder rank (Tier C), from iam.fn_user_org_role. */
      rank: number;
      /** The role's department name; null for the global anchor roles.
       *  Access gates combine rank AND department — see @platform/rbac. */
      department: string | null;
      /** iam.user_roles.name — the key the capability matrix is resolved by.
       *  Distinct from `role` above, which carries the coarse platform_role. */
      role_name: string | null;
      /** Tier C3 — capability keys this role holds in this tenant, from
       *  iam.role_capabilities. Gate on these with @platform/rbac's `can()`
       *  rather than comparing ranks: rank orders people, capabilities decide
       *  actions, and only the latter is tenant-editable without a deploy. */
      capabilities: string[];
    };
  }
}

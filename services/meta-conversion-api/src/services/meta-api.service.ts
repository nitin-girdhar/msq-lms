import axios, { AxiosError } from 'axios';
import { metaConfig } from '../config/meta.config.js';

export interface MetaLeadApiResponse {
  id: string;
  form_id: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  field_data: Array<{ name: string; values: string[] }>;
  created_time?: string;
  platform?: string;
}

export interface CAPIDeliveryResult {
  httpStatus: number;
  metaResponse: unknown;
  status: 'SUCCESS' | 'FAILED';
  payloadSent: unknown;
  fbTraceId: string | undefined;
}

export async function fetchLeadFromMeta(
  leadId: string,
  accessToken: string,
  graphApiVersion: string,
): Promise<MetaLeadApiResponse> {
  const fields = metaConfig.graph_api.lead_fields.join(',');
  const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/${leadId}`;

  const response = await axios.get<MetaLeadApiResponse>(url, {
    params: { fields, access_token: accessToken },
    timeout: 10_000,
  });

  return response.data;
}

export async function sendCapiEvent(
  pixelId: string,
  accessToken: string,
  graphApiVersion: string,
  capiPayload: { data: unknown[] },
): Promise<CAPIDeliveryResult> {
  const endpoint = metaConfig.capi.endpoint_template
    .replace('{api_version}', graphApiVersion)
    .replace('{pixel_id}', pixelId);

  let httpStatus = 0;
  let metaResponse: unknown = null;
  let status: 'SUCCESS' | 'FAILED' = 'FAILED';
  let fbTraceId: string | undefined;

  try {
    const response = await axios.post(endpoint, capiPayload, {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15_000,
    });

    httpStatus = response.status;
    metaResponse = response.data;
    status = 'SUCCESS';
    fbTraceId = (response.data as Record<string, unknown>)?.fbtrace_id as string | undefined;
  } catch (err) {
    if (err instanceof AxiosError) {
      httpStatus = err.response?.status ?? 0;
      metaResponse = err.response?.data ?? { message: err.message };
    } else {
      metaResponse = { message: 'Unknown error during CAPI call' };
    }
    status = 'FAILED';
  }

  return { httpStatus, metaResponse, status, payloadSent: capiPayload, fbTraceId };
}

export interface ManagedPage {
  page_id: string;
  name: string | null;
}

/**
 * Every Meta Page the tenant's stored token manages — a TypeScript port of
 * meta-sync-scripts/common/graph_api.py::get_managed_pages (`GET /me/accounts`),
 * which until now was the only implementation and lived outside any API.
 *
 * Deliberate divergence from the Python original: that one requests
 * `fields=id,access_token` because it needs a PAGE access token to call
 * /leadgen_forms and /leads (the tenant-level token is a User/System-User token
 * and those two edges reject it with Meta error #190). This one exists only so
 * an admin can pick a page by NAME instead of pasting a raw numeric id, so it
 * asks for `id,name` and never requests the token at all. Not fetching a
 * credential is strictly safer than fetching one and remembering to strip it
 * before responding — there is nothing here to leak into a log, an error body
 * or a future refactor of the response shape.
 *
 * Paginated the same way as the Python: /me/accounts is cursor-paged and a
 * business with more than `limit` pages silently returns a truncated first page
 * otherwise. Capped so a misbehaving or hostile paging response cannot spin
 * forever inside a request.
 */
export async function getManagedPages(
  accessToken: string,
  graphApiVersion: string,
): Promise<ManagedPage[]> {
  const MAX_PAGES_OF_RESULTS = 20;
  const pages: ManagedPage[] = [];
  let after: string | undefined;

  for (let i = 0; i < MAX_PAGES_OF_RESULTS; i += 1) {
    const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/me/accounts`;
    const response = await axios.get<{
      data?: Array<{ id?: string; name?: string }>;
      paging?: { next?: string; cursors?: { after?: string } };
    }>(url, {
      params: { fields: 'id,name', limit: 100, access_token: accessToken, ...(after ? { after } : {}) },
      timeout: 10_000,
    });

    for (const page of response.data.data ?? []) {
      if (page.id) pages.push({ page_id: String(page.id), name: page.name ?? null });
    }

    after = response.data.paging?.cursors?.after;
    if (!after || !response.data.paging?.next) break;
  }

  return pages;
}

// ── Graph API retry / backoff ───────────────────────────────────────────────
//
// Everything above this line is called ONCE per inbound webhook delivery, where
// a bare request is defensible: Meta retries the whole delivery on failure.
// Everything below it is called from a BUTTON — "Fetch campaigns" walks an
// entire ad account, dozens to hundreds of campaigns across several cursor
// pages, in one request. At that volume a single un-retried 429 aborts the run
// and the admin sees a half-synced grid with no way to tell which half.
//
// msq-lms/meta-sync-scripts/common/graph_api.py:81-99 is the reference for what
// NOT to do here: a bare `requests.get` with `timeout=15`, no retry, no backoff,
// no 429 handling at all. That is survivable for a supervised CLI run someone
// watches and re-runs; it is not survivable for a button.
//
// Note: /act_<id>/campaigns requires `ads_read` on the stored token. A token
// provisioned only for leadgen fails these calls with Meta error #200 — which is
// a permissions problem, not a transient one, and is deliberately NOT retried.

/** Meta error codes that mean "you are being throttled", not "your request is wrong". */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 32, 613, 80004]);

const MAX_GRAPH_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;

/**
 * Ceiling on any single sleep. Meta's `estimated_time_to_regain_access` is
 * expressed in MINUTES and is routinely 5-60 of them; honouring it literally
 * would hang the admin's request for an hour. It is used as a signal that a
 * longer wait is warranted, capped to something a request can actually afford —
 * the run then reports that account in `errors` and the admin re-presses the
 * button, which is the honest outcome rather than a hung tab.
 */
const MAX_BACKOFF_MS = 15_000;

/** Percentage at which we slow ourselves down before Meta does it for us. */
const USAGE_THROTTLE_PCT = 90;
const USAGE_PAUSE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BusinessUseCaseUsage {
  usagePct: number;
  regainAccessMinutes: number;
}

/**
 * The worst of the three percentages Meta reports in `X-Business-Use-Case-Usage`,
 * across every object named in the header.
 *
 * Shape: `{ "<ad_account_id>": [{ call_count, total_cputime, total_time,
 * estimated_time_to_regain_access }] }`. Any of the three crossing 100 is what
 * produces the 429 — so reading them lets the engine pace itself through a large
 * account instead of sprinting into a block partway through and losing the rest
 * of the run.
 *
 * Returns null when the header is absent or unparseable. A header we cannot read
 * must never become an error in its own right: it is advisory, and the retry
 * path below still handles the 429 if we misjudge.
 */
export function parseBusinessUseCaseUsage(headerValue: unknown): BusinessUseCaseUsage | null {
  if (typeof headerValue !== 'string' || headerValue === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  let usagePct = 0;
  let regainAccessMinutes = 0;
  for (const entries of Object.values(parsed as Record<string, unknown>)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      for (const key of ['call_count', 'total_cputime', 'total_time']) {
        const v = e[key];
        if (typeof v === 'number' && v > usagePct) usagePct = v;
      }
      const regain = e['estimated_time_to_regain_access'];
      if (typeof regain === 'number' && regain > regainAccessMinutes) regainAccessMinutes = regain;
    }
  }
  return { usagePct, regainAccessMinutes };
}

function isRetryableGraphError(err: unknown): { retryable: boolean; regainAccessMinutes: number } {
  if (!(err instanceof AxiosError)) return { retryable: false, regainAccessMinutes: 0 };

  const usage = parseBusinessUseCaseUsage(err.response?.headers?.['x-business-use-case-usage']);
  const regainAccessMinutes = usage?.regainAccessMinutes ?? 0;

  // No response at all: a connect timeout or a dropped socket. Worth another go.
  if (!err.response) return { retryable: true, regainAccessMinutes };

  const status = err.response.status;
  if (status === 429 || status >= 500) return { retryable: true, regainAccessMinutes };

  const body = err.response.data as { error?: { code?: number } } | undefined;
  const code = body?.error?.code;
  if (typeof code === 'number' && RATE_LIMIT_ERROR_CODES.has(code)) {
    return { retryable: true, regainAccessMinutes };
  }

  // Everything else — #190 expired token, #200 missing ads_read, a malformed
  // request — is permanent. Retrying it only spends the attempt budget that a
  // genuinely throttled call needs.
  return { retryable: false, regainAccessMinutes };
}

function backoffMs(attempt: number, regainAccessMinutes: number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  // Meta reports minutes; any positive value means "wait longer than you were
  // going to", which here means the ceiling rather than the literal duration.
  const target = regainAccessMinutes > 0 ? MAX_BACKOFF_MS : exponential;
  const chosen = Math.min(Math.max(exponential, target), MAX_BACKOFF_MS);
  // Full jitter on the upper half, so two concurrent fetches against the same ad
  // account do not re-collide on every retry.
  return Math.floor(chosen / 2 + Math.random() * (chosen / 2));
}

export interface GraphRequestOptions {
  /** Called before each sleep, so a caller can surface "backing off" in its logs. */
  onBackoff?: ((info: { attempt: number; delay_ms: number; reason: string }) => void) | undefined;
  /**
   * Attempt budget; defaults to MAX_GRAPH_ATTEMPTS. The webhook path passes 1: a
   * retrying call with backoff could hold an inbound lead for a minute inside
   * Meta's delivery window over a DISPLAY value, which the next lead or the
   * Fetch button can fill in later.
   */
  maxAttempts?: number | undefined;
  /** Per-request timeout; defaults to 15s. */
  timeoutMs?: number | undefined;
}

/**
 * One Graph GET, retried with exponential backoff and full jitter — on
 * throttling and transient failures only.
 *
 * Throws the last AxiosError once the attempts are spent, so the caller decides
 * what a dead ad account means. The sync engine records it in `errors` and
 * carries on with the next account rather than failing the whole run.
 */
export async function graphGet<T>(
  url: string,
  params: Record<string, string | number>,
  options: GraphRequestOptions = {},
): Promise<T> {
  let lastError: unknown;
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_GRAPH_ATTEMPTS);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await axios.get<T>(url, { params, timeout: options.timeoutMs ?? 15_000 });

      // Self-pacing: close to the limit but not yet blocked. A short pause here
      // is far cheaper than the block it avoids, which would cost the remainder
      // of a multi-page account walk.
      const usage = parseBusinessUseCaseUsage(response.headers?.['x-business-use-case-usage']);
      if (usage && usage.usagePct >= USAGE_THROTTLE_PCT) {
        options.onBackoff?.({ attempt, delay_ms: USAGE_PAUSE_MS, reason: 'usage_high' });
        await sleep(USAGE_PAUSE_MS);
      }

      return response.data;
    } catch (err) {
      lastError = err;
      const { retryable, regainAccessMinutes } = isRetryableGraphError(err);
      if (!retryable || attempt === maxAttempts - 1) throw err;

      const delayMs = backoffMs(attempt, regainAccessMinutes);
      options.onBackoff?.({ attempt, delay_ms: delayMs, reason: 'rate_limited' });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

// ── Lead-pull edges: page tokens → leadgen forms → leads ────────────────────
//
// The three Graph calls the lead-pull engine walks, ported from
// msq-lms/meta-sync-scripts/common/graph_api.py. All three go through graphGet
// above, which the Python original has no equivalent of — it is a bare
// `requests.get` with `timeout=15`, no retry, no backoff and no 429 handling.
// That is survivable for a supervised CLI run someone watches and re-runs; it
// is not survivable for a button that walks every form on every page of a
// tenant.

/**
 * `{page_id: page_access_token}` for every Page this token's user/system-user
 * manages — a port of graph_api.py::get_managed_pages.
 *
 * THIS CALL IS NOT OPTIONAL, and it is why this function exists alongside
 * `getManagedPages` above rather than being folded into it. `/leadgen_forms`
 * and `/{form-id}/leads` accept a PAGE access token only: the tenant-level
 * token on `ext.meta_tenant_config` is a User/System-User token and both edges
 * reject it with Meta error #190. `getManagedPages` deliberately asks for
 * `id,name` and never requests a credential, because it exists only so an admin
 * can pick a page by name; this one must request `access_token`, so its result
 * is a secret and must never reach a response body or a log line.
 *
 * A page absent from the result is NOT an error here — the caller counts it and
 * reports the reason, as download_page_leads.py does, because the usual cause
 * (the Page moved to another Business, or the token lost access) is something
 * an admin can act on only if they can see it.
 */
export async function getManagedPageTokens(
  accessToken: string,
  graphApiVersion: string,
  options: GraphRequestOptions = {},
): Promise<Map<string, string>> {
  const MAX_PAGES_OF_RESULTS = 20;
  const tokens = new Map<string, string>();
  let after: string | undefined;

  for (let i = 0; i < MAX_PAGES_OF_RESULTS; i += 1) {
    const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/me/accounts`;
    const data = await graphGet<{
      data?: Array<{ id?: string; access_token?: string }>;
      paging?: { next?: string; cursors?: { after?: string } };
    }>(url, { fields: 'id,access_token', limit: 100, access_token: accessToken, ...(after ? { after } : {}) }, options);

    for (const page of data.data ?? []) {
      // First token wins, matching resolve_page_clients()'s setdefault: two
      // integrations can both manage a page, and re-resolving it per credential
      // row is how the Python originally re-synced the same page twice.
      if (page.id && page.access_token && !tokens.has(String(page.id))) {
        tokens.set(String(page.id), page.access_token);
      }
    }

    after = data.paging?.cursors?.after;
    if (!after || !data.paging?.next) break;
  }

  return tokens;
}

export interface MetaLeadGenForm {
  form_id: string;
  name: string | null;
  status: string | null;
  leads_count: number | null;
}

/**
 * Every leadgen form live on a Page right now.
 *
 * Asking the PAGE rather than reading `ext.meta_page_form_org_map`'s form_id
 * list is the whole point of the page-first walk: that list goes stale the
 * moment someone creates a new form, so a form_id-driven sync silently stops
 * seeing new leads. Confirmed live — `ext.meta_leads` already holds form ids
 * with no mapping row at all.
 *
 * Requires a PAGE access token (see getManagedPageTokens).
 */
export async function listLeadGenForms(
  pageId: string,
  pageAccessToken: string,
  graphApiVersion: string,
  options: GraphRequestOptions = {},
): Promise<MetaLeadGenForm[]> {
  const MAX_PAGES_OF_RESULTS = 50;
  const forms: MetaLeadGenForm[] = [];
  let after: string | undefined;

  for (let i = 0; i < MAX_PAGES_OF_RESULTS; i += 1) {
    const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/${pageId}/leadgen_forms`;
    const data = await graphGet<{
      data?: Array<{ id?: string; name?: string; status?: string; leads_count?: number }>;
      paging?: { next?: string; cursors?: { after?: string } };
    }>(
      url,
      {
        fields: 'id,name,status,leads_count,created_time',
        limit: 100,
        access_token: pageAccessToken,
        ...(after ? { after } : {}),
      },
      options,
    );

    for (const form of data.data ?? []) {
      if (!form.id) continue;
      forms.push({
        form_id: String(form.id),
        name: form.name ?? null,
        status: form.status ?? null,
        leads_count: typeof form.leads_count === 'number' ? form.leads_count : null,
      });
    }

    after = data.paging?.cursors?.after;
    if (!after || !data.paging?.next) break;
  }

  return forms;
}

/** Meta's Lead object, as the lead edge returns it. */
export interface RawGraphLead {
  id?: string;
  /** ISO-8601 ("2026-07-11T18:07:55+0000"), NOT a Unix timestamp — confirmed live. */
  created_time?: string;
  form_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  platform?: string;
  field_data?: Array<{ name: string; values: string[] }>;
}

export interface LeadsPageResult {
  leads: RawGraphLead[];
  /** Null when pagination has genuinely ended. */
  nextCursor: string | null;
}

/**
 * ONE page of `/{form-id}/leads`, plus the cursor for the next.
 *
 * `since`/`until` are sent as Meta's `filtering` param on `time_created`, and
 * that is an OPTIMISATION ONLY — this edge has been observed ignoring it
 * (graph_api.py:126-129 records exactly that). Every caller must still filter
 * client-side; `fetchFormLeads` in lead-pull.service.ts does both.
 *
 * Requires a PAGE access token.
 */
export async function fetchFormLeadsPage(
  formId: string,
  pageAccessToken: string,
  graphApiVersion: string,
  window: { after?: string | undefined; since?: Date | undefined; until?: Date | undefined; limit?: number },
  options: GraphRequestOptions = {},
): Promise<LeadsPageResult> {
  const filters: Array<{ field: string; operator: string; value: number }> = [];
  if (window.since) {
    filters.push({ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(window.since.getTime() / 1000) });
  }
  if (window.until) {
    filters.push({ field: 'time_created', operator: 'LESS_THAN', value: Math.floor(window.until.getTime() / 1000) });
  }

  const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/${formId}/leads`;
  const data = await graphGet<{
    data?: RawGraphLead[];
    paging?: { next?: string; cursors?: { after?: string } };
  }>(
    url,
    {
      fields: metaConfig.graph_api.lead_fields.join(','),
      limit: window.limit ?? 100,
      access_token: pageAccessToken,
      ...(window.after ? { after: window.after } : {}),
      ...(filters.length ? { filtering: JSON.stringify(filters) } : {}),
    },
    options,
  );

  const cursor = data.paging?.cursors?.after;
  return {
    leads: data.data ?? [],
    nextCursor: cursor && data.paging?.next ? cursor : null,
  };
}

export interface MetaCampaign {
  meta_campaign_id: string;
  name: string | null;
  objective: string | null;
  effective_status: string | null;
  /** Meta's own ISO-8601 created_time, passed through verbatim for ::timestamptz. */
  created_time: string | null;
}

const CAMPAIGN_FIELDS = 'id,name,objective,effective_status,created_time';

/**
 * One campaign's metadata, for the webhook path.
 *
 * Called ONLY when a campaign id has not been seen before — the
 * `ext.meta_campaigns` row is the cache, with an in-process LRU on top of it in
 * campaign-mapping.service.ts collapsing the burst of leads that arrives for a
 * brand-new campaign before the first row commits. One Graph call per NEW
 * campaign, never per lead.
 *
 * Returns null rather than throwing on a Graph failure: the caller is part-way
 * through creating a real customer lead, and a lead dropped because a metadata
 * lookup was throttled is strictly worse than a lead left temporarily untyped.
 */
export async function fetchCampaign(
  campaignId: string,
  accessToken: string,
  graphApiVersion: string,
  options: GraphRequestOptions = {},
): Promise<MetaCampaign | null> {
  const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/${campaignId}`;
  try {
    const data = await graphGet<{
      id?: string;
      name?: string;
      objective?: string;
      effective_status?: string;
      created_time?: string;
    }>(url, { fields: CAMPAIGN_FIELDS, access_token: accessToken }, options);

    return {
      meta_campaign_id: String(data.id ?? campaignId),
      name: data.name ?? null,
      objective: data.objective ?? null,
      effective_status: data.effective_status ?? null,
      created_time: data.created_time ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Every campaign in one ad account, cursor-paged.
 *
 * Capped the same way getManagedPages is: a misbehaving or hostile paging
 * response must not spin forever inside a request. At `limit=100` the cap covers
 * 5,000 campaigns, far past any real ad account here.
 *
 * Unlike fetchCampaign this THROWS on failure. Its caller is the sync engine,
 * which records the account in `errors` and moves on to the next — a silent null
 * would be indistinguishable from an empty account and would report a successful
 * fetch of nothing.
 */
export async function listAccountCampaigns(
  adAccountId: string,
  accessToken: string,
  graphApiVersion: string,
  options: GraphRequestOptions = {},
): Promise<MetaCampaign[]> {
  const MAX_PAGES_OF_RESULTS = 50;
  // Meta wants the act_ prefix in the path and admins paste the id either way.
  const account = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const campaigns: MetaCampaign[] = [];
  let after: string | undefined;

  for (let i = 0; i < MAX_PAGES_OF_RESULTS; i += 1) {
    const url = `${metaConfig.graph_api.base_url}/${graphApiVersion}/${account}/campaigns`;
    const data = await graphGet<{
      data?: Array<{
        id?: string;
        name?: string;
        objective?: string;
        effective_status?: string;
        created_time?: string;
      }>;
      paging?: { next?: string; cursors?: { after?: string } };
    }>(
      url,
      {
        fields: CAMPAIGN_FIELDS,
        limit: 100,
        access_token: accessToken,
        ...(after ? { after } : {}),
      },
      options,
    );

    for (const c of data.data ?? []) {
      if (!c.id) continue;
      campaigns.push({
        meta_campaign_id: String(c.id),
        name: c.name ?? null,
        objective: c.objective ?? null,
        effective_status: c.effective_status ?? null,
        created_time: c.created_time ?? null,
      });
    }

    after = data.paging?.cursors?.after;
    if (!after || !data.paging?.next) break;
  }

  return campaigns;
}

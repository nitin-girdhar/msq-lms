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

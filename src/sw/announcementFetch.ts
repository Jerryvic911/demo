import type { Announcement } from '@wraith-protocol/sdk/chains/stellar';
import { parseAnnouncementEvent } from '../lib/stellar/announcementEvent';
import { retentionErrorFromRpcMessage } from '../lib/stellar/scannerCursor';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 500;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validLedger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function callRpc(
  fetchFn: typeof fetch,
  rpcUrl: string,
  body: object,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Stellar RPC responded with HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!isRecord(data)) throw new Error('Stellar RPC returned a malformed response');
  return data;
}

/** Returns the JSON-RPC result, or throws. Nothing malformed may reach the caller's cursor. */
function resultOf(data: Record<string, unknown>, startLedger: number): Record<string, unknown> {
  if (data.error !== undefined && data.error !== null) {
    const message =
      isRecord(data.error) && typeof data.error.message === 'string' && data.error.message
        ? data.error.message
        : 'Stellar RPC returned an error';
    throw retentionErrorFromRpcMessage(startLedger, message) ?? new Error(message);
  }
  if (!isRecord(data.result)) throw new Error('Stellar RPC response is missing a result');
  return data.result;
}

async function latestLedgerFromRpc(rpcUrl: string, fetchFn: typeof fetch): Promise<number> {
  const data = await callRpc(fetchFn, rpcUrl, { jsonrpc: '2.0', id: 1, method: 'getLatestLedger' });
  const sequence = isRecord(data.result) ? validLedger(data.result.sequence) : undefined;
  if (sequence === undefined) throw new Error('Stellar RPC did not return a valid latest ledger');
  return sequence;
}

/**
 * Fetches every announcement from startLedger. Pages are consumed until the RPC
 * stops returning a new cursor; a short page is NOT the end. Any malformed
 * response throws, so callers never advance their scan cursor past data they
 * did not actually read.
 */
export async function fetchAnnouncements(
  rpcUrl: string,
  contractId: string,
  startLedger: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ announcements: Announcement[]; latestLedger: number }> {
  const announcements: Announcement[] = [];
  let cursor: string | undefined;
  let latestLedger = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const pagination: Record<string, unknown> = { limit: PAGE_LIMIT };
    const params: Record<string, unknown> = {
      filters: [{ type: 'contract', contractIds: [contractId] }],
      pagination,
    };
    if (cursor) pagination.cursor = cursor;
    else params.startLedger = startLedger;

    const data = await callRpc(fetchFn, rpcUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'getEvents',
      params,
    });
    const result = resultOf(data, startLedger);
    if (!Array.isArray(result.events)) {
      throw new Error('Stellar RPC result is missing an events array');
    }

    for (const event of result.events) {
      if (!isRecord(event)) continue;
      try {
        const announcement = parseAnnouncementEvent(event);
        if (announcement) announcements.push(announcement);
      } catch {
        // An individual undecodable event is skipped; the envelope itself was valid.
      }
    }

    const reported = validLedger(result.latestLedger);
    if (reported !== undefined) latestLedger = reported;

    const next =
      typeof result.cursor === 'string' && result.cursor.length > 0 ? result.cursor : undefined;
    if (!next || next === cursor) {
      if (latestLedger === 0) latestLedger = await latestLedgerFromRpc(rpcUrl, fetchFn);
      return { announcements, latestLedger };
    }
    cursor = next;
  }
  throw new Error('Too many announcement pages; scan stopped without advancing the cursor');
}

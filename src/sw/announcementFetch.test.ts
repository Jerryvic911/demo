import { describe, expect, it, vi } from 'vitest';

// Events with a string `id` decode to an announcement; anything else decodes to null.
vi.mock('../lib/stellar/announcementEvent', () => ({
  parseAnnouncementEvent: (event: Record<string, unknown>) =>
    typeof event.id === 'string'
      ? { schemeId: 1, stealthAddress: event.id, caller: 'C', ephemeralPubKey: '', metadata: '' }
      : null,
}));

import { fetchAnnouncements } from './announcementFetch';

type Body = {
  method: string;
  params?: { startLedger?: number; pagination?: { cursor?: string } };
};
type Reply = { status?: number; json: unknown };

function rpc(replies: Reply[]) {
  const bodies: Body[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    const reply = replies[bodies.length - 1];
    if (!reply) throw new Error('Unexpected extra RPC call');
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  const run = () => fetchAnnouncements('https://rpc.test', 'CCONTRACT', 42, fetchFn);
  return { bodies, run };
}

// Real cursor shape: the RPC's end-of-data cursor for ledger N, e.g.
// ledger 5256415 -> "0022576134814171135-4294967295" (seen on testnet).
const tip = (ledger: number) =>
  `${((BigInt(ledger) << 32n) | 0xffffffffn).toString().padStart(19, '0')}-4294967295`;

const page = (ids: string[], cursor?: string, latestLedger = 500): Reply => ({
  json: { result: { events: ids.map((id) => ({ id })), cursor, latestLedger } },
});
const addresses = (r: { announcements: { stealthAddress: string }[] }) =>
  r.announcements.map((a) => a.stealthAddress);

describe('tip cursor shape', () => {
  it('matches the real testnet cursor', () => {
    expect(tip(5256415)).toBe('0022576134814171135-4294967295');
  });
});

describe('fetchAnnouncements pagination', () => {
  it('follows the cursor across full pages and finishes at the tip', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => `a${i}`);
    const { bodies, run } = rpc([
      page(full, 'c1', 502),
      page(['b'], tip(503), 503),
      page([], tip(503), 503),
    ]);

    const result = await run();

    expect(result.announcements).toHaveLength(1001);
    expect(result.latestLedger).toBe(503);
    expect(bodies).toHaveLength(3);
    expect(bodies[0].params?.startLedger).toBe(42);
    expect(bodies[1].params?.pagination?.cursor).toBe('c1');
    expect(bodies[1].params?.startLedger).toBeUndefined();
  });

  it('keeps reading after a SHORT page when the RPC returns a cursor', async () => {
    const { bodies, run } = rpc([
      page(['a', 'b'], 'c1'),
      page(['c'], tip(600), 600),
      page([], tip(600), 600),
    ]);

    const result = await run();

    expect(addresses(result)).toEqual(['a', 'b', 'c']);
    expect(result.latestLedger).toBe(600);
    expect(bodies).toHaveLength(3);
    expect(bodies[1].params?.pagination?.cursor).toBe('c1');
  });

  it('finishes when an empty page echoes a cursor that has reached the latest ledger', async () => {
    // What the real RPC does when nothing new has been written.
    const { bodies, run } = rpc([page([], tip(700), 700), page([], tip(700), 700)]);

    const result = await run();

    expect(result).toEqual({ announcements: [], latestLedger: 700 });
    expect(bodies).toHaveLength(2);
  });

  it('stops when the cursor is absent', async () => {
    const { bodies, run } = rpc([page(['a'])]);
    expect(addresses(await run())).toEqual(['a']);
    expect(bodies).toHaveLength(1);
  });

  it('rejects a repeated cursor on a page that returned events', async () => {
    await expect(rpc([page(['a'], 'c1'), page(['b'], 'c1')]).run()).rejects.toThrow(/repeated/);
  });

  it('rejects a repeated cursor it cannot prove is the tip', async () => {
    await expect(rpc([page(['a'], 'c1'), page([], 'c1')]).run()).rejects.toThrow(/repeated/);
  });

  it('rejects an empty repeated cursor that is still behind the latest ledger', async () => {
    const { run } = rpc([page([], tip(100), 500), page([], tip(100), 500)]);
    await expect(run()).rejects.toThrow(/repeated/);
  });

  it('skips an undecodable event but keeps the rest of the page', async () => {
    const { run } = rpc([
      { json: { result: { events: [{ id: 'a' }, 'junk', null], latestLedger: 9 } } },
    ]);
    expect(addresses(await run())).toEqual(['a']);
  });
});

describe('fetchAnnouncements response validation', () => {
  it.each([
    ['no result', { json: {} }],
    ['null result', { json: { result: null } }],
    ['no events field', { json: { result: { latestLedger: 5 } } }],
    ['non-array events', { json: { result: { events: 'nope', latestLedger: 5 } } }],
    ['array envelope', { json: [] }],
    ['JSON-RPC error', { json: { error: { message: 'boom' } } }],
    ['HTTP 500', { status: 500, json: {} }],
  ] as [string, Reply][])('rejects %s instead of reporting an empty scan', async (_name, reply) => {
    await expect(rpc([reply]).run()).rejects.toThrow();
  });

  it('rejects a malformed page in the middle of pagination', async () => {
    const { run } = rpc([page(['a'], 'c1'), { json: { result: {} } }]);
    await expect(run()).rejects.toThrow();
  });

  it('asks getLatestLedger when the page has no valid latestLedger', async () => {
    const { bodies, run } = rpc([
      { json: { result: { events: [{ id: 'a' }] } } },
      { json: { result: { sequence: 777 } } },
    ]);
    expect((await run()).latestLedger).toBe(777);
    expect(bodies[1].method).toBe('getLatestLedger');
  });

  it('rejects when no valid latest ledger can be obtained', async () => {
    const { run } = rpc([
      { json: { result: { events: [] } } },
      { json: { result: { sequence: 0 } } },
    ]);
    await expect(run()).rejects.toThrow();
  });
});

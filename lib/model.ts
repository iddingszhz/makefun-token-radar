// Launch-value radar: the model behind the token launch board.
//
// The board ranks pre-token protocols by what a launch would be worth if the
// protocol's record stayed as it is. It never predicts whether or when a token
// appears. Every number in the ranking comes from the snapshot's own figures:
// the protocol's TVL, its seven-day TVL change, and how long it has run with
// no token. No protocol name is ever special-cased; one function scores them
// all, and the dashboard prints the derivation for every row.
//
//   size multiple  TVL bands, diminishing: a launch is worth more per dollar
//                  of TVL while a protocol is small, less once it is large.
//                  < $100M -> 0.42, $100M-$500M -> 0.30,
//                  $500M-$2B -> 0.20, >= $2B -> 0.12
//   growth factor  1 + clamp(change_7d, -30, +60) / 100 * 0.8
//                  A falling TVL drags the launch value down; a rising one
//                  lifts it, but a single wild week cannot carry the board.
//   age factor     0.55 + 0.45 * min(age_days, 900) / 900
//                  Older pre-token protocols have survived longer without a
//                  token, so a launch is worth more; unknown age counts as
//                  240 days.
//   implied value  max(1, round(tvl * size_multiple * growth_factor * age_factor))
//
// The board covers the snapshot's whole watchlist (the floor) and adds the
// 200 pre-token protocols below the floor with the highest implied value:
// the early rows the radar exists to find. Live-token protocols are kept
// apart in their own view, shown at the market's own value.

/** One protocol entry, exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants. The dashboard prints them next to the board. */
export interface LaunchConstants {
  /** Size multiples by TVL band, smallest band first. */
  size_bands: Array<{ below_usd: number; multiple: number }>;
  growth_floor_pct: number;
  growth_cap_pct: number;
  growth_weight: number;
  age_floor: number;
  age_range: number;
  age_cap_days: number;
  unknown_age_days: number;
}

export const LAUNCH: LaunchConstants = {
  size_bands: [
    { below_usd: 100_000_000, multiple: 0.42 },
    { below_usd: 500_000_000, multiple: 0.3 },
    { below_usd: 2_000_000_000, multiple: 0.2 },
    { below_usd: Number.POSITIVE_INFINITY, multiple: 0.12 },
  ],
  growth_floor_pct: -30,
  growth_cap_pct: 60,
  growth_weight: 0.8,
  age_floor: 0.55,
  age_range: 0.45,
  age_cap_days: 900,
  unknown_age_days: 240,
};

/** The model's label, printed by the dashboard. */
export const MODEL_LABEL = 'launch-value-1';

/** How many pre-token protocols below the watchlist floor the board adds. */
export const EARLY_COUNT = 200;

/** How many live-token protocols the dashboard's live view carries. */
export const LIVE_COUNT = 20;

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    size_multiple: number;
    growth_pct: number;
    growth_factor: number;
    age_factor: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row in the dashboard's compact form, farm steps included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  size_multiple: number;
  growth_factor: number;
  age_factor: number;
  on_watchlist: boolean;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: LaunchConstants;
  model_label: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else the fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The size multiple for a TVL: the first band whose ceiling the TVL sits under. */
export function sizeMultiple(tvlUsd: number, model: LaunchConstants): number {
  for (const band of model.size_bands) {
    if (tvlUsd < band.below_usd) return band.multiple;
  }
  return model.size_bands[model.size_bands.length - 1]!.multiple;
}

export interface ScoredValue {
  implied: number;
  sizeMultiple: number;
  growthPct: number;
  growthFactor: number;
  ageFactor: number;
  age: number | null;
}

/** The implied value of one protocol under the model, with every factor shown. */
export function impliedValue(p: SnapshotProtocol, asOf: string, model: LaunchConstants): ScoredValue {
  const age = ageDays(asOf, p.listed_at);
  const size = sizeMultiple(p.tvl_usd, model);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(model.growth_cap_pct, Math.max(model.growth_floor_pct, rawGrowth));
  const growthFactor = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const ageFactor =
    model.age_floor + (Math.min(Math.max(ageForModel, 0), model.age_cap_days) / model.age_cap_days) * model.age_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * size * growthFactor * ageFactor));
  return { implied, sizeMultiple: size, growthPct, growthFactor, ageFactor, age };
}

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED_NAME.test(p.name);
}

/** The snapshot's protocols by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The ranked board: the whole watchlist plus the best early rows by implied value. */
export function buildBoard(snapshot: Snapshot, model: LaunchConstants = LAUNCH): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Early rows: pre-token protocols below the watchlist floor, picked by implied
  // value, not by TVL alone, so a small fast-growing protocol can outrank a
  // large flat one. A chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, model) }))
    .sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, EARLY_COUNT);
  for (const e of early) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      size_multiple: s.v.sizeMultiple,
      growth_pct: round4(s.v.growthPct),
      growth_factor: round4(s.v.growthFactor),
      age_factor: round4(s.v.ageFactor),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_COUNT)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow, onWatchlist: boolean): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    size_multiple: row.model.size_multiple,
    growth_factor: row.model.growth_factor,
    age_factor: row.model.age_factor,
    on_watchlist: onWatchlist,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: LaunchConstants = LAUNCH): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const watchlist = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_label: MODEL_LABEL,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => radarRow(r, watchlist.has(r.slug))),
    live,
  };
  return { board, radar };
}

// --- Farm plans -----------------------------------------------------------
// Every plan is derived from the protocol's own record: its category picks the
// action, its first chain sets the gas, its TVL sets the capital, its age
// sets the hold. No name is ever special-cased.

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on the protocol's first chain, in dollars. */
function gasUsd(chain: string): number {
  switch (chain) {
    case 'Ethereum':
      return 9;
    case 'Arbitrum':
    case 'Optimism':
    case 'Base':
      return 0.6;
    case 'Solana':
      return 0.05;
    case 'Binance':
      return 0.3;
    case 'Polygon':
      return 0.1;
    case 'Avalanche':
      return 0.5;
    default:
      return 2;
  }
}

/** The capital one farm position needs, from the protocol's TVL. */
function capitalUsd(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 500;
  if (p.tvl_usd >= 100_000_000) return 250;
  return 100;
}

/** How long to hold, from the protocol's age: younger protocols need a longer window. */
function holdDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 540) return 60;
  return 30;
}

/** The category's action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC into ${name} on ${chain} and leave it earning.`;
  }
  if (c.includes('dex') || c.includes('amm')) {
    return `Add $${capital} to ${name}'s largest pool on ${chain} as liquidity and hold the LP receipt.`;
  }
  if (c.includes('bridge')) {
    return `Move $${capital} of USDC across ${name} onto ${chain} and put the bridged funds to work in its app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain asset with ${name} and keep the liquid receipt.`;
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options')) {
    return `Post $${capital} of USDC as margin on ${name} and open one small hedged trade.`;
  }
  if (c.includes('yield')) {
    return `Deposit $${capital} into ${name}'s highest-yield vault on ${chain} and let it compound.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) {
    return `Allocate $${capital} to a ${name} vault on ${chain} and keep the vault shares.`;
  }
  if (c.includes('stable')) {
    return `Mint or hold $${capital} of ${name}'s stable asset on ${chain}.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and take one market position on ${name}.`;
  }
  if (c.includes('leveraged farm')) {
    return `Open a $${capital} leveraged farming position on ${name} on ${chain} and watch the health factor.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as a single string: action, cost, time. Kept inside the gate's 20..600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position open and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: six steps, each with what it costs and how long it
 * takes. Derived from the protocol's own record, never from a list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const gas = gasUsd(chain);
  const capital = capitalUsd(p);
  const hold = holdDays(age);
  const gasText = gas >= 1 ? `about $${gas} of gas` : `about $${gas} of gas`;
  return [
    stepText(
      'Open a fresh wallet used only for this farm and keep its seed phrase offline.',
      `${gasText} for the first transaction`,
      '10 minutes',
    ),
    stepText(actionFor(p, capital, chain), `$${capital} of capital plus ${gasText}`, '20 minutes to set up'),
    stepText(
      'Return once a week and make one real on-chain action: a deposit, a swap, a vote or a borrow.',
      `${gasText} a week`,
      '10 minutes a week',
    ),
    stepText(
      `Keep the position open for at least ${hold} days so it is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      "Once a month, check the protocol's own points page and claim only from links it publishes.",
      'free to check; never pay to claim',
      '10 minutes a month',
    ),
    stepText(
      'Write the wallet, the dates and every transaction hash in a farm log, and decide your exit before any token event.',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

// --- Snapshot parsing -----------------------------------------------------

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `the board ranks ${r.slug} twice`;
    seen.add(r.slug);
    const known = snapshot.protocols.some((p) => p.slug === r.slug);
    if (!known) return `the board ranks ${r.slug}, which the snapshot does not list`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
  }
  return null;
}

/** The dashboard's data as one script: no fetch, no network. The source line is
 *  kept free of addresses so the page carries no URL anywhere. */
export function dataScript(radar: RadarData): string {
  const clean: RadarData = {
    ...radar,
    source: radar.source.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim(),
  };
  return `window.RADAR=${JSON.stringify(clean)};\n`;
}

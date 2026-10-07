// Types for fares-usage.js, so the Fares widget (TypeScript) can import it.
export interface FaresUsageRun {
  startedAt: string;
  ok?: boolean | null;
  seconds?: number | null;
  travelpayouts?: number | null;
  serpapi?: number | null;
  eventSearches?: number | null;
}

export interface FaresUsageContext {
  coords?: (code: string) => [number, number] | null;
  history?: { runs?: FaresUsageRun[] } | null;
  plan?: number | null;
  today?: Date;
}

export type UsageLevel = 'ok' | 'warn' | 'over';

export interface EventUsage {
  name: string;
  state: 'past' | 'waiting' | 'checking';
  opensOn: string;
  perMonth: number;
  thisMonth: number;
}

export interface UsageEstimate {
  travelpayouts: { perRun: number; roundTrip: number; openJaw: number; seconds: number; level: UsageLevel };
  serpapi: {
    plan: number;
    reserve: number;
    perRun: number;
    runsPerMonth: number;
    dealChecks: number;
    events: EventUsage[];
    eventChecks: number;
    worst: number;
    likely: number | null;
    share: number;
    level: UsageLevel;
    runsOutDay: number | null;
    likelyRunsOutDay: number | null;
  };
}

export const DAYS_PER_MONTH: number;
export const SERPAPI_FREE_PLAN: number;
export const SECONDS_PER_LOOKUP: number;
export const WARN_SHARE: number;
export const LOOKUPS_WARN: number;
export const LOOKUPS_OVER: number;
export function kmBetween(a: [number, number], b: [number, number]): number;
export function openJawReturns(cfg: any, coords: (code: string) => [number, number] | null): Record<string, string[]>;
export function eventUsage(ev: any, cfg: any, today: Date): EventUsage;
export function estimateUsage(cfg: any, ctx?: FaresUsageContext): UsageEstimate;

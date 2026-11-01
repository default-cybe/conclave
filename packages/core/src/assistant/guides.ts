/// <reference path="../agents-defaults/markdown.d.ts" />
/**
 * Life-area guides the assistant reads on demand (GoalList and GoalGet with
 * guide: true): how to run goal intake in that area, what to record, how to
 * help over time, and where help stops. Embedded as text like the agent
 * defaults, so the compiled binary needs no files.
 */
import type { GoalArea } from './types';
import study from '../agents-defaults/guides/study.md' with { type: 'text' };
import career from '../agents-defaults/guides/career.md' with { type: 'text' };
import health from '../agents-defaults/guides/health.md' with { type: 'text' };
import money from '../agents-defaults/guides/money.md' with { type: 'text' };
import homelab from '../agents-defaults/guides/homelab.md' with { type: 'text' };
import relationships from '../agents-defaults/guides/relationships.md' with { type: 'text' };
import interests from '../agents-defaults/guides/interests.md' with { type: 'text' };
import other from '../agents-defaults/guides/other.md' with { type: 'text' };
import planWeek from '../agents-defaults/guides/flows/plan-week.md' with { type: 'text' };
import mealPlan from '../agents-defaults/guides/flows/meal-plan.md' with { type: 'text' };
import meeting from '../agents-defaults/guides/flows/meeting.md' with { type: 'text' };
import timeBooking from '../agents-defaults/guides/flows/time-booking.md' with { type: 'text' };

const GUIDES: Record<GoalArea, string> = { study, career, health, money, homelab, relationships, interests, other };

/** The guide for an area. */
export function goalGuide(area: GoalArea): string {
  return (GUIDES[area] ?? GUIDES.other).trim();
}

/** Flows the assistant runs with the calendar (docs/DESIGN.md, Calendar and mail), read on demand through DayPlan guide. */
export type FlowGuide = 'plan-week' | 'meal-plan' | 'meeting' | 'time-booking';

export const FLOW_GUIDES: Record<FlowGuide, string> = { 'plan-week': planWeek, 'meal-plan': mealPlan, meeting, 'time-booking': timeBooking };

/** The guide for a flow, or undefined for a name that is not one. */
export function flowGuide(name: string): string | undefined {
  return (FLOW_GUIDES as Record<string, string>)[name]?.trim();
}

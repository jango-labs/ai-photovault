import type { PublishState } from '../status';

export interface CalendarItem {
  id: string;
  photo: { src: string; alt: string; title: string };
  /** instant, ISO 8601 */
  scheduledAt: string;
  /** IANA zone the user scheduled in (the wall-clock time is preserved when moving between days) */
  timeZone: string;
  state: PublishState;
  /** species / internal title shown under the photograph */
  label?: string;
  error?: string;
}

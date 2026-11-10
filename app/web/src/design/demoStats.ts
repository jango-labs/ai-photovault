import { makeHistory } from './fixtures';

/** Number of POSSIBLE matches in the (synthetic) demo archive: shown as the review badge on the History tab. Replaced by an API count later. */
export const demoReviewCount = (): number => makeHistory(60).filter((h) => h.match?.state === 'POSSIBLE_MATCH').length;

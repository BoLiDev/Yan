import { postJSON, type ReviewAsked, type ReviewSaved } from '../../lib/api';
import { onStatus, queryClient } from '../../state/server';
import { toast } from '../../state/ui';

/**
 * A review on its way out of the page: written to the vault, which serve
 * commits and pushes, and the task's agent on this machine asked to take
 * it up, as Done has it close the task. What goes wrong is said, with why:
 * a review not written, a push that failed, the review kept here and
 * pushed later, an agent that could not be asked, the review written all
 * the same.
 */

/** Write a review to the vault; what serve answers, or null when it was not written, which has been said. */
export async function writeReview(asked: ReviewAsked): Promise<ReviewSaved | null> {
  try {
    const saved = await postJSON<ReviewSaved>('/api/review', asked);
    void onStatus(saved.status);
    if (saved.warning) toast(`The review is saved here, but the push failed: ${saved.warning}`, true);
    return saved;
  } catch (err) {
    toast(`The review was not saved: ${(err as Error).message}`, true);
    return null;
  }
}

/** Ask the task's agent on this machine to take up the review last written; whether it was, the reason said when it was not. */
export async function askAgent(task: string): Promise<boolean> {
  try {
    await postJSON('/api/task/review', { task });
  } catch (err) {
    toast(`The review is saved, but its agent was not asked: ${(err as Error).message}`, true);
    return false;
  }
  await queryClient.invalidateQueries({ queryKey: ['terminals'] });
  return true;
}

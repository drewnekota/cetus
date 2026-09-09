/** Explicit choices survive virtualization and regrouping. Defaults are never
 * stored: an untouched live group may expand on an incomplete finish, while
 * a user's choice takes priority. The latest choice wins when groups merge. */
export class DisclosureState {
  private choices = new Map<string, { open: boolean; revision: number }>();
  private revision = 0;

  get(id: string | undefined, fallback: boolean, relatedIds: readonly string[] = []): boolean {
    let choice = id ? this.choices.get(id) : undefined;
    for (const related of relatedIds) {
      const candidate = this.choices.get(related);
      if (candidate && (!choice || candidate.revision > choice.revision)) choice = candidate;
    }
    return choice?.open ?? fallback;
  }

  set(id: string, open: boolean) {
    this.choices.set(id, { open, revision: ++this.revision });
  }
}

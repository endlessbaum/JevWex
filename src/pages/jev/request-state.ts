// Shared by UI and tests: edits invalidate pending results without freezing inputs.
export class RequestState {
  private revision = 0;
  private serial = 0;
  edit() {
    this.revision++;
  }
  begin() {
    return { revision: this.revision, id: ++this.serial };
  }
  cancel() {
    this.serial++;
  }
  accepts(ticket: { revision: number; id: number }) {
    return ticket.id === this.serial && ticket.revision === this.revision;
  }
}

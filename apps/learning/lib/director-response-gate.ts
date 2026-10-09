/** A settled mutation invalidates reads begun before its durable response, including mid-command reads. */
export function createDirectorResponseGate() {
  let mutation = 0;
  let read = 0;
  return {
    beginRead: () => ({ mutation, read: ++read }),
    acceptsRead: (ticket: { mutation: number; read: number }) =>
      ticket.mutation === mutation && ticket.read === read,
    beginCommand: () => ++mutation,
    isCurrentCommand: (ticket: number) => ticket === mutation,
    commitCommand: (ticket: number): boolean => {
      if (ticket !== mutation) return false;
      mutation += 1;
      return true;
    },
  };
}

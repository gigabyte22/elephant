import { v7 as uuidv7 } from 'uuid';

// UUID v7: time-ordered, sortable, conflict-free across distributed writers.
// Used for every node id so Episode/Fact ordering can be reconstructed without a separate timestamp index.
export function newId(): string {
  return uuidv7();
}

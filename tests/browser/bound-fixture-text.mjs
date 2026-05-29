// The plaintext used only by the test fixture to compute a real text
// binding and to drive the record-page checker. It never appears in the
// served record (the record carries only the salted commitment), so it is
// safe here and must stay identical between the fixture server and the spec.
export const BOUND_TEXT =
  "We cannot prove a human wrote this, but here is the recorded shape of the writing process for anyone who cares to look.";

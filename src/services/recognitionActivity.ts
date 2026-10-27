/** One heavy recognition operation in this process, including explicit rescans/batch tools. */
let holder: symbol | null = null;
export function acquireRecognitionActivity(): (() => void) | null {
  if (holder) return null;
  const token = Symbol(); holder = token;
  return () => { if (holder === token) holder = null; };
}

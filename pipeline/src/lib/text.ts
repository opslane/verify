/**
 * Model-written strings are a forgery surface wherever a person reads them: strip C0/C1
 * controls, line separators and bidi overrides so what is displayed is what was written.
 * A newline becomes a space; anything else becomes its visible escape.
 */
export function sanitizeLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (ch) =>
    ch === '\n' ? ' ' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

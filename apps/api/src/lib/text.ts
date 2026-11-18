/** True if the text has no control characters. `allowLayout` permits tab and line breaks (multi-line text). */
export const hasNoControlChars = (text: string, allowLayout = false): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const layout = c === 9 || c === 10 || c === 13;
    if ((c < 32 && !(allowLayout && layout)) || c === 127) return false;
  }
  return true;
};

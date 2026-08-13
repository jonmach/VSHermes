/**
 * Pure transformation for file-mode image references in stored messages —
 * no vscode imports, unit-testable.
 *
 * File-mode image transfer stores a text reference in the message:
 *   [Image pasted: /abs/path.png — if you need to see it, analyze it …]
 * On render, the host maps the path to a webview-loadable URI and swaps the
 * whole reference for a markdown image, giving history real thumbnails.
 */
export function enrichImageRefs(
  content: string | null,
  toUri: (filePath: string) => string | null,
): string | null {
  if (!content) return content;
  return content.replace(/\[Image pasted: ([^\s\]]+)[^\]]*\]/g, (match, p: string) => {
    const uri = toUri(p);
    return uri ? `![Image](${uri})` : match;
  });
}

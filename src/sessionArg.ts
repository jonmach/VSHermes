/**
 * Normalize tree-item command arguments to a session id string.
 *
 * view/item/context commands receive the TreeItem ELEMENT, while a
 * TreeItem.command row click receives the explicit arguments array.
 * Both shapes must resolve to the plain session id string.
 */
export function sessionIdFromArg(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object') {
    const obj = arg as { session?: { id?: unknown }; id?: unknown };
    if (typeof obj.session?.id === 'string') return obj.session.id;
    if (typeof obj.id === 'string') return obj.id;
  }
  return undefined;
}

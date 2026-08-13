/**
 * Normalize tree-item command arguments to a session target
 * (endpoint id + session id).
 *
 * TreeItem.command row clicks receive the explicit arguments array (the
 * new { ep, sid } shape from the grouped history tree); view/item/context
 * commands receive the TreeItem ELEMENT (a SessionTreeItem carrying
 * endpointId + session). Legacy bare-string / {id} shapes resolve to the
 * currently active endpoint (endpointId null = "don't switch").
 */

import { LOCAL_ENDPOINT_ID } from './endpointCore';

export interface SessionTarget {
  /** Endpoint id the session lives on; null = the active endpoint. */
  endpointId: string | null;
  sessionId: string;
}

/** A bare session id (legacy shapes) targets the active endpoint. */
export function currentServerTarget(sessionId: string): SessionTarget {
  return { endpointId: null, sessionId };
}

export function sessionTargetFromArg(arg: unknown): SessionTarget | undefined {
  if (typeof arg === 'string') return currentServerTarget(arg);
  if (arg && typeof arg === 'object') {
    const obj = arg as {
      ep?: unknown;
      sid?: unknown;
      endpointId?: unknown;
      session?: { id?: unknown };
      id?: unknown;
    };
    if (typeof obj.ep === 'string' && typeof obj.sid === 'string') {
      return { endpointId: obj.ep, sessionId: obj.sid };
    }
    if (typeof obj.endpointId === 'string' && typeof obj.session?.id === 'string') {
      return { endpointId: obj.endpointId, sessionId: obj.session.id };
    }
    if (typeof obj.session?.id === 'string') return currentServerTarget(obj.session.id);
    if (typeof obj.id === 'string') return currentServerTarget(obj.id);
  }
  return undefined;
}

export { LOCAL_ENDPOINT_ID };

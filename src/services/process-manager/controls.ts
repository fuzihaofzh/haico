/** Currently disabled; Task scheduler owns runtime backoff decisions. */
export function isAgentInCooldown(_agentId: string): boolean {
  return false;
}

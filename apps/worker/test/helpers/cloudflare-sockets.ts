// Node has no Workers sockets binding. Tests that exercise TCP must provide an
// explicit socket mock; merely importing the production entry must remain safe.
export function connect(): never {
  throw new Error('TCP tests require an explicit cloudflare:sockets mock or workerd');
}

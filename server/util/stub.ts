/**
 * TEMPORARY scaffolding: a service whose methods throw "not implemented". Lets every domain compile
 * and run its own tests before the others land. Removed at integration.
 */
export function stubService<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === "start" || prop === "stop" || prop === "then" || typeof prop === "symbol") return undefined;
      return () => {
        throw new Error(`${name}.${String(prop)} is not implemented yet`);
      };
    },
  });
}

// Type checking is pure computation and fans out safely. Tests are not: they
// spawn processes, bind sockets, and talk to Postgres, and several suites here
// assume they are not competing for a core — running them concurrently makes a
// different handful of timing-sensitive suites fail on every run. They stay
// sequential until the suites themselves tolerate contention.
//
// This lives apart from the runner so a test can assert that the script names
// the root gate actually invokes are the ones listed here. Held as a bare
// string set inside the runner, a rename would silently restore concurrency to
// the test phase and the flakiness would look like an unrelated regression.
export const SEQUENTIAL_SCRIPTS: ReadonlySet<string> = new Set(["test"]);

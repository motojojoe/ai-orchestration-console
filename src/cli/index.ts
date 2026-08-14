import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as commands from "./commands";
import { EXIT } from "./exit-codes";

const USAGE = `usage:
  orch run "<task>" [--project <path>]   run the pipeline in this directory
  orch resume <id>                       re-enter a run parked at a gate
  orch list                              recent runs
  orch show <id>                         one run in detail
  orch cancel <id>                       cancel a parked or stranded run
  orch doctor                            check claude and opencode auth
  orch help | --help | -h                this message
`;

const OPTIONS = {
  project: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true });
  } catch (err) {
    // parseArgs throws ERR_PARSE_ARGS_UNKNOWN_OPTION / _INVALID_OPTION_VALUE /
    // _UNEXPECTED_POSITIONAL. Uncaught, those reached index.ts's bottom handler as a bare message
    // and exit 2 — "a stage failed" in this CLI's contract — for what is a usage error, and the
    // text was Node's, not ours: `orch --version` printed "To specify a positional argument
    // starting with a '-' …" and never showed the usage.
    if (String((err as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS_")) {
      process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
      return EXIT.USAGE;
    }
    throw err;
  }
  const { positionals, values } = parsed;

  // Asking for help is not a usage error, so it prints to stdout and exits 0 — a wrapper running
  // `orch --help` should not read a failure. Being handed a command we do not recognise still
  // prints the same text to stderr and exits 64, below.
  if (values.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }

  const [command, arg] = positionals;
  switch (command) {
    case "help":
      process.stdout.write(USAGE);
      return EXIT.OK;
    case "list":
      return commands.list();
    case "show":
      if (!arg) {
        process.stderr.write("show needs a run id\n");
        return EXIT.USAGE;
      }
      return commands.show(arg);
    case "doctor":
      return commands.doctor();
    case "run": {
      if (!arg) {
        process.stderr.write('run needs a task, e.g. orch run "add a health endpoint"\n');
        return EXIT.USAGE;
      }
      // resolve() here, at the boundary where the untrusted value enters: project_path is
      // persisted and later read by other processes with other working directories (orch cancel,
      // the web app). git.ts derives worktree_path from it verbatim, so a relative --project
      // stores a relative worktree_path, and removeRunWorktree's existsSync() guard then finds
      // nothing and returns success without removing anything — an orphaned worktree, silently.
      // process.cwd() is already absolute; only the flag is the hole.
      return commands.run(arg, resolve(values.project ?? process.cwd()));
    }
    case "resume":
      if (!arg) {
        process.stderr.write("resume needs a run id\n");
        return EXIT.USAGE;
      }
      return commands.resume(arg);
    case "cancel":
      if (!arg) {
        process.stderr.write("cancel needs a run id\n");
        return EXIT.USAGE;
      }
      return commands.cancel(arg);
    default:
      process.stderr.write(USAGE);
      return EXIT.USAGE;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = EXIT.FAILED;
  },
);

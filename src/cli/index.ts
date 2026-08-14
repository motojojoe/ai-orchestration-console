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
`;

async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "string" } },
    strict: true,
  });

  const [command, arg] = positionals;
  switch (command) {
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

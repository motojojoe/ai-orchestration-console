async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version") {
    process.stdout.write("orch 0.1.0\n");
    return 0;
  }
  process.stderr.write("usage: orch --version\n");
  return 64;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  },
);

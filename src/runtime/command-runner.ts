import { spawn } from "node:child_process";

export type CommandRunner = (command: string, args: string[], label: string) => Promise<void>;

export function createCommandRunner(awsRegion: string): CommandRunner {
  return async (command: string, args: string[], label: string): Promise<void> => {
    console.log(`${label}: ${command} ${args.join(" ")}`);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        stdio: "inherit",
        env: { ...process.env, AWS_DEFAULT_REGION: awsRegion },
      });

      child.on("exit", (code, signal) => {
        if (code === 0) {
          resolvePromise();
          return;
        }

        rejectPromise(new Error(`${command} exited with code=${code ?? "null"} signal=${signal ?? "null"}`));
      });

      child.on("error", (error) => {
        rejectPromise(error);
      });
    });
  };
}

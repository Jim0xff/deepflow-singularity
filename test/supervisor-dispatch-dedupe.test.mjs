describe("supervisor dispatch dedupe", () => {
  test("failed dispatch must not advance dedupe cursor", () => {
    const runtime = {};
    const dispatchKey = "step7:100:writer";
    const statusMtimeMs = 100;
    const run = { status: 1, stdout: "", stderr: "boom" };

    const dispatched = run.status === 0;

    if (dispatched) {
      runtime.last_dispatch_key = dispatchKey;
      runtime.last_dispatch_status_mtime_ms = statusMtimeMs;
    } else {
      runtime.last_dispatch_failed_at = "now";
    }
    runtime.last_dispatch_exit_code = run.status;

    expect(runtime.last_dispatch_key).toBeUndefined();
    expect(runtime.last_dispatch_status_mtime_ms).toBeUndefined();
    expect(runtime.last_dispatch_failed_at).toBeDefined();
    expect(runtime.last_dispatch_exit_code).toBe(1);
  });
});

// Run before every test file. A suite started from inside a yan session, or by
// a shift, inherits the variables that name that task and shift; a test that
// omits --task would then resolve the real one instead of reporting the usage
// error it is about, and every child `runYan` spawns inherits the same. The
// machine-level variables (YAN_HOME, YAN_VAULT, YAN_MACHINE_DIR) stay, because
// every fixture sets the ones it needs on its own.
for (const key of ['YAN_TASK', 'YAN_TASK_DIR', 'YAN_SID', 'YAN_SHIFT_DIR']) {
  delete process.env[key];
}
